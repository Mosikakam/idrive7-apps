'use strict';

// mgu-uplink gives each permitted app its own lease. The MGU's system DNS
// resolver cannot resolve public names through that connection.
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const path = require('path');

function error(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

function lookupFor(dataDir) {
    return function lookup(hostname, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        let lease;
        try { lease = JSON.parse(fs.readFileSync(path.join(dataDir, 'uplink.json'), 'utf8')); }
        catch (e) { lease = null; }
        if (!lease || !lease.ip)
            return process.nextTick(() => cb(error('Приложение не получило интернет-подключение', 'EUPLINK')));

        const servers = Array.isArray(lease.dns) ? lease.dns.filter((ip) => net.isIP(ip) === 4) : [];
        if (!servers.length)
            return process.nextTick(() => cb(error('В подключении не указаны серверы DNS', 'EUPLINKDNS')));

        let resolver;
        try {
            resolver = new dns.Resolver();
            resolver.setServers(servers);
        } catch (e) { return process.nextTick(() => cb(e)); }

        let done = false;
        const finish = (err, address) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            cb(err, address, address ? 4 : undefined);
        };
        const timer = setTimeout(() => {
            finish(error('Сервер DNS не ответил вовремя', 'EDNSTIMEOUT'));
            try { resolver.cancel(); } catch (e) {}
        }, 10000);
        try {
            resolver.resolve4(hostname, (err, addresses) => {
                if (err) return finish(err);
                if (!addresses || !addresses.length) return finish(error('Не найден IPv4-адрес сервиса погоды', 'ENODNS'));
                finish(null, addresses[0]);
            });
        } catch (e) { finish(e); }
    };
}

module.exports = { lookupFor };
