'use strict';
// Run after: python3 kit/tools/build.py --preview-only bmw_weather
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const https = require('https');

const source = path.join(__dirname, '..', '..', 'dist', 'bmw_weather', 'source');
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
assert.strictEqual(pkg.name, 'bmw_weather');
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

let status = 200, requests = 0;
const originalGet = https.get;
https.get = function (url, opts, callback) {
    requests++;
    assert.ok(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/.test(url));
    assert.ok(url.indexOf('latitude=53.017') >= 0);
    assert.ok(url.indexOf('forecast_days=5') >= 0);
    const req = new EventEmitter();
    req.setTimeout = function () {};
    req.destroy = function (err) { req.emit('error', err); };
    const res = new EventEmitter();
    res.statusCode = status;
    res.setEncoding = function () {};
    process.nextTick(() => {
        callback(res);
        res.emit('data', JSON.stringify(sample));
        res.emit('end');
    });
    return req;
};

(async function () {
    try {
        const ctx = { settings: { get: (key) => key === 'temperatureUnit' ? 'c' : '30' },
            canvas: (w, h) => new Canvas(w, h) };
        const log = { info() {}, warn() {} };
        const model = weather.createModel(ctx, log);
        await model.refresh();
        assert.strictEqual(requests, 1);
        assert.strictEqual(model.snapshot().data.current.temperature_2m, 2);
        assert.strictEqual(model.snapshot().error, '');
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
        weather.drawWidget(ctx, model.snapshot());
        console.log('BMW Weather package, forecast and drawing checks passed.');
    } finally {
        https.get = originalGet;
    }
})().catch((e) => { console.error(e); process.exitCode = 1; });
