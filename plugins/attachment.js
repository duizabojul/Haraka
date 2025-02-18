'use strict';
/*eslint no-shadow: ["error", { "allow": ["file", "depth", "code", "signal"] }]*/
// attachment

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const utils = require('haraka-utils');

let tmp;
let bsdtar_path;
let archives_disabled = false;
const default_archive_extns = [
    '.zip', '.tar', '.tgz', '.taz', '.z', '.gz', '.rar', '.7z'
];

exports.register = function () {
    try {
        tmp = require('tmp');
        tmp.setGracefulCleanup();
    }
    catch (e) {
        archives_disabled = true;
        this.logwarn(`This plugin requires the 'tmp' module to extract filenames from archive files`);
    }
    this.load_attachment_ini();
    this.register_hook('data_post', 'wait_for_attachment_hooks');
    this.register_hook('data_post', 'check_attachments');
}

exports.load_attachment_ini = function () {
    const plugin = this;

    plugin.cfg = plugin.config.get('attachment.ini', () => {
        plugin.load_attachment_ini();
    });

    plugin.cfg.timeout = (plugin.cfg.main.timeout || 30) * 1000;
    plugin.archive_max_depth = plugin.cfg.main.archive_max_depth || 5;
    plugin.archive_exts = options_to_array(plugin.cfg.main.archive_extensions) ||
        default_archive_extns;
}

exports.find_bsdtar_path = cb => {
    let found = false;
    let i = 0;
    ['/bin', '/usr/bin', '/usr/local/bin'].forEach((dir) => {
        if (found) return;
        i++;
        fs.stat(`${dir}/bsdtar`, (err) => {
            i--;
            if (found) return;
            if (err) {
                if (i===0) cb(new Error('bsdtar not found'));
                return;
            }
            found = true;
            cb(null, dir);
        });
        if (i===0) cb(new Error('bsdtar not found'));
    });
}

exports.hook_init_master = exports.hook_init_child = function (next) {
    const plugin = this;

    plugin.find_bsdtar_path((err, dir) => {
        if (err) {
            archives_disabled = true;
            plugin.logwarn(`This plugin requires the 'bsdtar' binary to extract filenames from archive files`);
        }
        else {
            plugin.logdebug(`found bsdtar in ${dir}`);
            plugin.bsdtar_path = bsdtar_path = `${dir}/bsdtar`;
        }
        return next();
    });
}

function options_to_array (options) {
    if (!options) return false;
    const arr = options.toLowerCase().replace(/\s+/,' ').split(/[;, ]/);
    let len = arr.length;
    while (len--) {
        // Remove any empty elements
        if (arr[len] === "" || arr[len] === null) {
            arr.splice(len, 1);
        }
        else {
            arr[len] = arr[len].trim();
        }
    }
    return (arr.length ? arr : false);
}

exports.unarchive_recursive = async function (connection, f, archive_file_name, cb) {
    if (archives_disabled) {
        connection.logdebug(this, 'archive support disabled');
        return cb();
    }

    const plugin = this;
    const tmpfiles = [];

    let timeouted = false;
    let encrypted = false;
    let depthExceeded = false;

    function timeoutedSpawn (cmd_path, args, env, pipe_stdout_ws) {
        connection.logdebug(plugin, `running "${cmd_path} ${args.join(' ')}"`);

        return new Promise(function (resolve, reject) {

            let output = '';
            const p = spawn(cmd_path, args, env);

            // Start timer
            let timeout = false;
            const timer = setTimeout(() => {
                timeout = timeouted = true;
                p.kill();

                reject(`command "${cmd_path} ${args}" timed out`);
            },  plugin.cfg.timeout);


            if (pipe_stdout_ws) {
                p.stdout.pipe(pipe_stdout_ws);
            }
            else {
                p.stdout.on('data', (data) => output += data);
            }

            p.stderr.on('data', (data) => {

                if (data.includes('Incorrect passphrase')) {
                    encrypted = true;
                }

                // it seems that stderr might be sometimes filled after exit so we rather print it out than wait for result
                connection.logdebug(plugin, `"${cmd_path} ${args.join(' ')}": ${data}`);
            });

            p.on('exit', (code, signal) => {
                if (timeout) return;
                clearTimeout(timer);

                if (code && code > 0) {
                    // Error was returned
                    return reject(`"${cmd_path} ${args.join(' ')}" returned error code: ${code}}`);
                }


                if (signal) {
                    // Process terminated due to signal
                    return reject(`"${cmd_path} ${args.join(' ')}" terminated by signal: ${signal}`);
                }

                return resolve(output);
            });
        });
    }

    function createTmp () {
        // might be better to use async version of tmp in future not cb based
        return new Promise((resolve, reject) => {
            tmp.file((err, tmpfile, fd) => {
                if (err) reject(err);

                const t = {};
                t.name = tmpfile;
                t.fd = fd;

                resolve(t);
            });
        });
    }

    async function unpackArchive (in_file, file) {

        const t = await createTmp();
        tmpfiles.push([t.fd, t.name]);

        connection.logdebug(plugin, `created tmp file: ${t.name} (fd=${t.fd}) for file ${file}`);

        const tws = fs.createWriteStream(t.name);
        try {
            // bsdtar seems to be asking for password if archive is encrypted workaround with --passphrase will end up
            // with "Incorrect passphrase" for encrypted archives, but will be ignored with nonencrypted
            await timeoutedSpawn(bsdtar_path,
                ['-Oxf', in_file, `--include=${file}`, '--passphrase', 'deliberately_invalid'],
                {
                    'cwd': '/tmp',
                    'env': {
                        'LANG': 'C'
                    },
                },
                tws
            );
        }
        catch (e) {
            connection.logdebug(plugin, e);
        }
        return t;
    }

    async function listArchive (in_file) {
        try {
            const lines = await timeoutedSpawn(bsdtar_path, ['-tf', in_file, '--passphrase', 'deliberately_invalid'], {
                'cwd': '/tmp',
                'env': {'LANG': 'C'},
            });

            // Extract non-empty filenames
            return lines.split(/\r?\n/).filter(fl => fl);
        }
        catch (e) {
            connection.logdebug(plugin, e);
            return [];
        }
    }


    function deleteTempFiles () {
        tmpfiles.forEach(t => {
            fs.close(t[0], () => {
                connection.logdebug(plugin, `closed fd: ${t[0]}`);
                fs.unlink(t[1], () => {
                    connection.logdebug(plugin, `deleted tempfile: ${t[1]}`);
                });
            });
        });
    }

    function isArchive (file) {
        const extn = path.extname(file.toLowerCase());
        return plugin.archive_exts.includes(extn) || plugin.archive_exts.includes(extn.substring(1));
    }

    async function processFile (in_file, prefix, file, depth) {
        let result = [(prefix ? `${prefix}/` : '') + file];

        connection.logdebug(plugin, `found file: ${prefix ? `${prefix}/` : ''}${file} depth=${depth}`);

        if (!isArchive(file)) {
            return result;
        }

        connection.logdebug(plugin, `need to extract file: ${prefix ? `${prefix}/` : ''}${file}`);

        const t = await unpackArchive(in_file, file);

        // Recurse
        try {
            result = result.concat(await listFiles(t.name, (prefix ? `${prefix}/` : '') + file, depth + 1));
        }
        catch (e) {
            connection.logdebug(plugin, e);
        }

        return result;
    }

    async function listFiles (in_file, prefix, depth) {
        const result = [];
        depth = depth || 0;

        if (timeouted) {
            connection.logdebug(plugin, `already timeouted, not going to process ${prefix ? `${prefix}/` : ''}${in_file}`);
            return result;
        }

        if (depth >= plugin.archive_max_depth) {
            depthExceeded = true;
            connection.logdebug(plugin, `hit maximum depth with ${prefix ? `${prefix}/` : ''}${in_file}`);
            return result;
        }

        const fls = await listArchive(in_file);
        await Promise.all(fls.map(async (file) => {
            const output = await processFile(in_file, prefix, file, depth + 1);
            result.push(...output);
        }));

        connection.loginfo(plugin, `finish (${prefix ? `${prefix}/` : ''}${in_file}): count=${result.length} depth=${depth}`);
        return result;
    }

    setTimeout(() => {
        timeouted = true;
    }, plugin.cfg.timeout);

    const files = await listFiles(f, archive_file_name);
    deleteTempFiles();

    if (timeouted) {
        cb(new Error("archive extraction timeouted"), files);
    }
    else if (depthExceeded) {
        cb(new Error("maximum archive depth exceeded"), files);
    }
    else if (encrypted) {
        cb(new Error("archive encrypted"), files);
    }
    else {
        cb(null, files);
    }
}

exports.start_attachment = function (connection, ctype, filename, body, stream) {
    const plugin = this;
    const txn = connection?.transaction;

    function next () {
        if (txn?.notes?.attachment_next && txn.notes.attachment_count === 0) {
            return txn.notes.attachment_next();
        }
    }

    // Parse Content-Type
    let ct;
    if ((ct = ctype.match(/^([^/]+\/[^;\r\n ]+)/)) && ct[1]) {
        connection.logdebug(plugin, `found content type: ${ct[1]}`);
        txn.notes.attachment_ctypes.push(ct[1]);
    }

    // Parse filename
    let ext;
    let fileext = '.unknown';
    if (filename) {
        if ((ext = filename.match(/(\.[^. ]+)$/)) && ext[1]) {
            fileext = ext[1].toLowerCase();
        }
        txn.notes.attachment_files.push(filename);
    }

    // Calculate and report the md5 of each attachment
    const md5 = crypto.createHash('md5');
    let digest;
    let bytes = 0;

    stream.on('data', (data) => {
        md5.update(data);
        bytes += data.length;
    });

    stream.once('end', () => {
        stream.pause();

        digest = md5.digest('hex');
        connection.loginfo(plugin, `file="${filename}" ctype="${ctype}" md5=${digest} bytes=${bytes}`);
        txn.notes.attachments.push({
            ctype: ((ct && ct[1]) ? ct[1].toLowerCase() : 'unknown/unknown'),
            filename: (filename ? filename : ''),
            extension: (ext && ext[1] ? ext[1].toLowerCase() : ''),
            md5: ((digest) ? digest : ''),
        });
    });

    if (!filename) return;
    connection.logdebug(plugin, `found attachment file: ${filename}`);
    // See if filename extension matches archive extension list
    // We check with the dot prefixed and without
    if (archives_disabled || (!plugin.archive_exts.includes(fileext) &&
        !plugin.archive_exts.includes(fileext.substring(1)))) {
        return;
    }
    connection.logdebug(plugin, `found ${fileext} on archive list`);
    txn.notes.attachment_count++;
    stream.connection = connection;
    stream.pause();
    tmp.file((err, fn, fd) => {
        function cleanup () {
            fs.close(fd, () => {
                connection.logdebug(plugin, `closed fd: ${fd}`);
                fs.unlink(fn, () => {
                    connection.logdebug(plugin, `unlinked: ${fn}`);
                });
            });
            stream.resume();
        }
        if (err) {
            txn.notes.attachment_result = [ DENYSOFT, err.message ];
            connection.logerror(plugin, `Error writing tempfile: ${err.message}`);
            txn.notes.attachment_count--;
            cleanup();
            stream.resume();
            return next();
        }
        connection.logdebug(plugin, `Got tmpfile: attachment="${filename}" tmpfile="${fn}" fd={fd}`);

        const ws = fs.createWriteStream(fn);
        stream.pipe(ws);
        stream.resume();

        ws.on('error', (error) => {
            txn.notes.attachment_count--;
            txn.notes.attachment_result = [ DENYSOFT, error.message ];
            connection.logerror(plugin, `stream error: ${error.message}`);
            cleanup();
            return next();
        });

        ws.on('close', () => {
            connection.logdebug(plugin, 'end of stream reached');
            connection.pause();
            plugin.unarchive_recursive(connection, fn, filename, (error, files) => {
                txn.notes.attachment_count--;
                cleanup();
                if (err) {
                    connection.logerror(plugin, error.message);
                    if (err.message === 'maximum archive depth exceeded') {
                        txn.notes.attachment_result = [ DENY, 'Message contains nested archives exceeding the maximum depth' ];
                    }
                    else if (/Encrypted file is unsupported/i.test(error.message)) {
                        if (!plugin.cfg.main.allow_encrypted_archives) {
                            txn.notes.attachment_result = [ DENY, 'Message contains encrypted archive' ];
                        }
                    }
                    else if (/Mac metadata is too large/i.test(error.message)) {
                        // Skip this error
                    }
                    else {
                        if (!connection.relaying) {
                            txn.notes.attachment_result = [ DENYSOFT, 'Error unpacking archive' ];
                        }
                    }
                }

                txn.notes.attachment_archive_files = txn.notes.attachment_archive_files.concat(files);
                connection.resume();
                return next();
            });
        });
    });
}


exports.hook_data = function (next, connection) {
    const plugin = this;
    if (!connection?.transaction) return next();
    const txn = connection?.transaction;

    txn.parse_body = 1;
    txn.notes.attachment_count = 0;
    txn.notes.attachments = [];
    txn.notes.attachment_ctypes = [];
    txn.notes.attachment_files = [];
    txn.notes.attachment_archive_files = [];
    txn.attachment_hooks((ctype, filename, body, stream) => {
        plugin.start_attachment(connection, ctype, filename, body, stream);
    });
    return next();
}

exports.check_attachments = function (next, connection) {
    const txn = connection?.transaction;
    if (!txn) return next();

    const ctype_config = this.config.get('attachment.ctype.regex','list');
    const file_config = this.config.get('attachment.filename.regex','list');
    const archive_config = this.config.get('attachment.archive.filename.regex','list');

    // Add in any wildcard configuration
    const ctype_wc = this.config.get('attachment.ctype.wc', 'list');
    for (let i=0; i<ctype_wc.length; i++) {
        ctype_config.push(utils.wildcard_to_regexp(ctype_wc[i]));
    }
    const file_wc = this.config.get('attachment.filename.wc', 'list');
    for (let i=0; i<file_wc.length; i++) {
        file_config.push(utils.wildcard_to_regexp(file_wc[i]));
    }
    const archive_wc = this.config.get('attachment.archive.filename.wc', 'list');
    for (let i=0; i<archive_wc.length; i++) {
        archive_config.push(utils.wildcard_to_regexp(archive_wc[i]));
    }

    // Check for any stored errors from the attachment hooks
    if (txn.notes.attachment_result) {
        const result = txn.notes.attachment_result;
        return next(result[0], result[1]);
    }

    const ctypes = txn.notes.attachment_ctypes;

    // Add in any content type from message body
    const body = txn.body;
    let body_ct;
    if (body && (body_ct = /^([^/]+\/[^;\r\n ]+)/.exec(body.header.get('content-type')))) {
        connection.logdebug(this, `found content type: ${body_ct[1]}`);
        ctypes.push(body_ct[1]);
    }
    // MIME parts
    if (body && body.children) {
        for (let c=0; c<body.children.length; c++) {
            let child_ct;
            if (body.children[c] && (child_ct = /^([^/]+\/[^;\r\n ]+)/.exec(body.children[c].header.get('content-type')))) {
                connection.logdebug(this, `found content type: ${child_ct[1]}`);
                ctypes.push(child_ct[1]);
            }
        }
    }

    const ctypes_result = this.check_items_against_regexps(ctypes, ctype_config);
    if (ctypes_result) {
        connection.loginfo(this, `match ctype="${ctypes_result[0]}" regexp=/${ctypes_result[1]}/`);
        return next(DENY, `Message contains unacceptable content type (${ctypes_result[0]})`);
    }

    const files = txn.notes.attachment_files;
    const files_result = this.check_items_against_regexps(files, file_config);
    if (files_result) {
        connection.loginfo(this, `match file="${files_result[0]}" regexp=/${files_result[1]}/`);
        return next(DENY, `Message contains unacceptable attachment (${files_result[0]})`);
    }

    const archive_files = txn.notes.attachment_archive_files;
    const archives_result = this.check_items_against_regexps(archive_files, archive_config);
    if (archives_result) {
        connection.loginfo(this, `match file="${archives_result[0]}" regexp=/${archives_result[1]}/`);
        return next(DENY, `Message contains unacceptable attachment (${archives_result[0]})`);
    }

    return next();
}

exports.check_items_against_regexps = function (items, regexps) {
    if ((regexps && Array.isArray(regexps) && regexps.length > 0) &&
        (items && Array.isArray(items) && items.length > 0)) {
        for (let r=0; r < regexps.length; r++) {
            let reg;
            try {
                reg = new RegExp(regexps[r], 'i');
            }
            catch (e) {
                this.logerror(`skipping invalid regexp: /${regexps[r]}/ (${e})`);
            }
            if (reg) {
                for (let i=0; i < items.length; i++) {
                    if (reg.test(items[i])) {
                        return [ items[i], regexps[r] ];
                    }
                }
            }
        }
    }
    return false;
}

exports.wait_for_attachment_hooks = (next, connection) => {
    if (connection?.transaction?.notes?.attachment_count > 0) {
        connection.transaction.notes.attachment_next = next;
    }
    else {
        next();
    }
}
