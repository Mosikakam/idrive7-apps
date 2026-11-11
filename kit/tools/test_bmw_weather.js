'use strict';
// Run after: python3 kit/tools/build.py --preview-only bmw_weather
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');
const os = require('os');
const Module = require('module');

const source = path.join(__dirname, '..', '..', 'dist', 'bmw_weather', 'source');
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
assert.strictEqual(pkg.name, 'bmw_weather');
assert.strictEqual(pkg.version, '1.0.4');
assert.strictEqual(pkg.mguInternet, true, 'built package must request Internet Uplink');
const weather = require(path.join(source, 'javascript', 'weather'));
const Canvas = require(path.join(source, 'javascript', 'kit', 'canvas')).Canvas;

const sample = {
    current: { temperature_2m: 2, apparent_temperature: -1, relative_humidity_2m: 75,
        wind_speed_10m: 12, weather_code: 61 },
    daily: { time: ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'],
        weather_code: [61, 3, 0, 71, 2], temperature_2m_max: [4, 5, 6, 0, 3],
        temperature_2m_min: [-2, -1, 0, -4, -3], precipitation_probability_max: [70, 20, 0, 50, 10] },
};

let status = 200, requests = 0, simulateTimeout = false;
const originalGet = https.get;
const originalResolver = dns.Resolver;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-weather-'));
let usedDns;
dns.Resolver = class {
    setServers(servers) { usedDns = servers; }
    resolve4(host, callback) {
        assert.strictEqual(host, 'api.open-meteo.com');
        process.nextTick(() => callback(null, ['203.0.113.42']));
    }
    cancel() {}
};
https.get = function (opts, callback) {
    requests++;
    assert.strictEqual(arguments.length, 2, 'Node.js 8 supports only (options, callback)');
    assert.strictEqual(typeof callback, 'function');
    assert.strictEqual(opts.hostname, 'api.open-meteo.com');
    assert.strictEqual(typeof opts.lookup, 'function');
    assert.ok(/^\/v1\/forecast\?/.test(opts.path));
    assert.ok(opts.path.indexOf('latitude=53.017') >= 0);
    assert.ok(opts.path.indexOf('forecast_days=5') >= 0);
    const req = new EventEmitter();
    req.setTimeout = function (ms, fn) { assert.strictEqual(ms, 25000); req.timeout = fn; };
    req.destroy = function (err) { req.emit('error', err); };
    const res = new EventEmitter();
    res.statusCode = status;
    res.setEncoding = function () {};
    const socket = new EventEmitter();
    process.nextTick(() => {
        req.emit('socket', socket);
        opts.lookup(opts.hostname, {}, (err, address, family) => {
        if (err) return req.emit('error', err);
        assert.strictEqual(address, '203.0.113.42');
        assert.strictEqual(family, 4);
        socket.emit('connect');
        socket.emit('secureConnect');
        if (simulateTimeout) return req.timeout();
        callback(res);
        res.emit('data', JSON.stringify(sample));
        res.emit('end');
        });
    });
    return req;
};

(async function () {
    try {
        const ctx = { dataDir: tempDir, settings: { get: (key) => key === 'temperatureUnit' ? 'c' : '30' },
            canvas: (w, h) => new Canvas(w, h) };
        const log = { info() {}, warn() {} };
        const model = weather.createModel(ctx, log);
        await model.refresh();
        assert.strictEqual(model.snapshot().detail, 'No Internet Uplink lease for Weather');
        fs.writeFileSync(path.join(tempDir, 'uplink.json'), JSON.stringify({ ip: '192.0.2.2', dns: ['192.0.2.1'] }));
        await model.refresh();
        assert.strictEqual(requests, 2);
        assert.deepStrictEqual(usedDns, ['192.0.2.1']);
        assert.strictEqual(model.snapshot().data.current.temperature_2m, 2);
        assert.strictEqual(model.snapshot().error, '');
        assert.ok(weather.widgetSummary(model.snapshot()).indexOf('Weather: 2°') === 0);
        const widget = weather.drawWidget(ctx, model.snapshot());
        assert.strictEqual(widget.w, 768);
        assert.strictEqual(widget.h, 512);
        assert.ok(widget.png().length > 1000);
        const screen = weather.drawScreen(ctx, model.snapshot());
        assert.strictEqual(screen.w, 1600);
        assert.ok(screen.png().length > 1000);
        status = 503;
        await model.refresh();
        assert.strictEqual(model.snapshot().data.current.temperature_2m, 2, 'keep last good forecast');
        assert.strictEqual(model.snapshot().error, 'Weather unavailable');
        assert.strictEqual(model.snapshot().detail, 'Weather service HTTP 503');
        assert.ok(weather.widgetSummary(model.snapshot()).indexOf('offline') >= 0);
        weather.drawWidget(ctx, model.snapshot());
        simulateTimeout = true;
        await model.refresh();
        assert.strictEqual(model.snapshot().detail, 'Weather idle timeout during HTTP response');
        // A widget-only launch never calls start(ctx): its loop must be installed by background(bg).
        let impl, widgetDraw, calls = 0, cells = [];
        const mainPath = path.join(__dirname, '..', '..', 'apps', 'bmw_weather', 'main.js');
        const oldLoad = Module._load;
        const fakeModel = { updateSettings() {}, refresh() {}, snapshot() { return {}; } };
        Module._load = function (request, parent) {
            if (parent && parent.filename === mainPath && request === './kit/mgu')
                return { run: (entry) => { impl = entry; } };
            if (parent && parent.filename === mainPath && request === './weather')
                return { createModel() { calls++; return fakeModel; }, widgetSummary() { return 'Weather: loading'; },
                    drawWidget() { return { image: true }; }, drawScreen() { return {}; } };
            return oldLoad.apply(this, arguments);
        };
        try { require(mainPath); } finally { Module._load = oldLoad; }
        const mockWidget = { onChange() {}, loop(fps, fn) { widgetDraw = fn; },
            set(id, cell, value) { cells.push([id, cell, value]); } };
        const bg = { settings: { onChange() {} }, widget: mockWidget, log };
        assert.strictEqual(await impl.background(bg), fakeModel);
        assert.strictEqual(calls, 1);
        assert.strictEqual(typeof widgetDraw, 'function');
        assert.deepStrictEqual(widgetDraw({ spawnId: 3 }), { image: true });
        assert.deepStrictEqual(cells, [[3, 'TextRecordings', 'Weather: loading']]);
        await impl.start({ background: fakeModel, ui: { onClick() {} }, loop() {} });
        console.log('BMW Weather package, forecast and drawing checks passed.');
    } finally {
        https.get = originalGet;
        dns.Resolver = originalResolver;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exitCode = 1; });
