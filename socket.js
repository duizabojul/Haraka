'use strict'

const net = require('net');
const Ref = require('ref-napi');
const FFI = require('ffi-napi');
const os = require('os');

const SOL_SOCKET = 1
const SO_BINDTODEVICE = 25;

const C_TYPE_INT = Ref.types.int;
const C_TYPE_VOID = Ref.types.void;

const ffi = FFI.Library(null, {
    setsockopt: [C_TYPE_INT, [C_TYPE_INT, C_TYPE_INT, C_TYPE_INT, Ref.refType(C_TYPE_VOID), C_TYPE_INT]],
})


function get_interface_for_ip(ip) {
    const interfaces = os.networkInterfaces();
    for (let iface in interfaces) {
        if (interfaces[iface][0].address === ip) {
            return iface
        }
    }
}

const setsockopt = (fd, level, name, value, valueLength) => {
    const err = ffi.setsockopt(fd, level, name, value, valueLength)

    if (err !== 0) {
        let errno = FFI.errno()
        throw new Error('setsockopt ' + errno)
    }

    return true
}


function createSocket(port, host, cb) {
    let conn_options = {};
    if (typeof port === 'object') {
        conn_options = port;
    } else {
        conn_options.port = port;
        conn_options.host = host;
    }

    if (conn_options.localAddress && get_interface_for_ip(conn_options.localAddress)) {

        const iface = get_interface_for_ip(conn_options.localAddress);
        const ifaceBuffer = new Buffer.from(iface);

        const socket = net.connect(conn_options)
        process.nextTick(() => setsockopt(socket._handle.fd, SOL_SOCKET, SO_BINDTODEVICE, ifaceBuffer, ifaceBuffer.length))
        return socket;
    } else {
        return net.connect(conn_options);
    }
}

module.exports = {createSocket};