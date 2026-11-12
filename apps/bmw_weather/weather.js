'use strict';

const https = require('https');
const { lookupFor } = require('./uplink');
const wttr = require('./wttr');
const { ScaledCanvas } = require('./kit/canvas');
const W = 384, H = 256;
const widgetCanvas = new ScaledCanvas(W, H, 2);
// Petropavlovsk-Kamchatsky city centre; these are not vehicle GPS coordinates.
const LOCATION_LATITUDE = 53.017;
const LOCATION_LONGITUDE = 158.650;

function requestJson(hostname, path, lookup) {
    return new Promise((resolve, reject) => {
        let phase = 'DNS', finished = false, deadline, tcpDeadline;
        function complete(err, value) {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            clearTimeout(tcpDeadline);
            if (err) reject(err); else resolve(value);
        }
        function tracedLookup(hostname, options, callback) {
            lookup(hostname, options, (err, address, family) => {
                if (!err) {
                    phase = 'TCP connection';
                    tcpDeadline = setTimeout(() => {
                        const failure = new Error(hostname + ' TCP connection timed out');
                        failure.code = 'EWEATHERTCP';
                        req.destroy(failure);
                    }, 15000);
                }
                callback(err, address, family);
            });
        }
        // MGU runs Node.js 8. The (url, options, callback) overload needs Node.js 10.9+.
        const req = https.get({ hostname, path, lookup: tracedLookup,
            headers: { 'User-Agent': 'BMW-MGU-Weather/1.0', 'Accept': 'application/json' } }, (res) => {
            phase = 'response body 0B';
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
                phase = 'response body ' + body.length + 'B';
                if (body.length > 200000) req.destroy(new Error('Weather response too large'));
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) return complete(new Error('Weather service HTTP ' + res.statusCode));
                try { complete(null, JSON.parse(body)); } catch (e) { complete(e); }
            });
            res.on('error', complete);
        });
        req.on('socket', (socket) => {
            socket.on('connect', () => { clearTimeout(tcpDeadline); phase = 'TLS handshake'; });
            socket.on('secureConnect', () => { phase = 'HTTP response'; });
        });
        req.setTimeout(12000, () => req.destroy(new Error('Weather idle timeout during ' + phase)));
        deadline = setTimeout(() => req.destroy(new Error('Weather total timeout during ' + phase)), 25000);
        req.on('error', complete);
    });
}

function failureText(e) {
    if (!e) return 'unknown error';
    if (e.code === 'EWEATHERTCP') return 'TCP timeout';
    if (/^EUPLINK/.test(e.code || '')) return e.message;
    return String(e.code || e.message || e).replace(/^Weather service /, '');
}

const DESCRIPTIONS = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Showers',
    82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm',
    96: 'Thunderstorm', 99: 'Thunderstorm'
};

function number(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function describe(code) { return DESCRIPTIONS[code] || 'Weather'; }
function temp(v, unit) {
    if (number(v) === null) return '--°';
    const n = unit === 'f' ? v * 9 / 5 + 32 : v;
    return Math.round(n) + '°';
}

function createModel(ctx, log) {
    let data = null, error = 'Waiting for weather', detail = '', updated = 0;
    let source = '';
    let lat = LOCATION_LATITUDE, lon = LOCATION_LONGITUDE, unit = 'c', refreshMs = 30 * 60000;
    let lastAttempt = 0, refreshing = false;
    const lookup = lookupFor(ctx.dataDir);
    function updateSettings() {
        const s = ctx.settings;
        lat = LOCATION_LATITUDE;
        lon = LOCATION_LONGITUDE;
        unit = s.get('temperatureUnit') === 'f' ? 'f' : 'c';
        refreshMs = (parseInt(s.get('refreshMinutes'), 10) || 30) * 60000;
    }
    async function refresh() {
        if (refreshing) return;
        updateSettings();
        refreshing = true;
        lastAttempt = Date.now();
        try {
            const forecast = wttr.convert(await requestJson('wttr.is', '/' + lat + ',' + lon + '?format=j2', lookup));
            data = forecast; updated = Date.now(); error = ''; detail = ''; source = 'wttr.is';
            log.info('weather updated from ' + source);
        } catch (e) {
            error = 'Weather unavailable';
            detail = (/^EUPLINK/.test(e.code || '') ? '' : 'wttr.is ') + failureText(e);
            detail = detail.slice(0, 90);
            log.warn('weather: ' + detail + '; ' + (e.stack || e));
        } finally { refreshing = false; }
    }
    const timer = setInterval(() => { if (Date.now() - lastAttempt >= refreshMs) refresh(); }, 60000);
    if (timer.unref) timer.unref();
    return {
        refresh, updateSettings,
        snapshot() { return { data, error, detail, updated, unit, source }; }
    };
}

function widgetSummary(snap) {
    if (!snap.data) return snap.detail ? 'Weather: ' + snap.detail : 'Weather: loading';
    const current = snap.data.current;
    return snap.error ? 'Weather: offline, last ' + temp(current.temperature_2m, snap.unit)
        : 'Weather: ' + temp(current.temperature_2m, snap.unit) + ' ' + describe(current.weather_code);
}

function icon(cv, code, x, y, scale, phase) {
    const rain = code >= 51 && code <= 67 || code >= 80 && code <= 82 || code >= 95;
    const snow = code >= 71 && code <= 77 || code === 85 || code === 86;
    const cloudy = code !== 0 && code !== 1;
    const sun = code <= 2;
    if (sun) {
        const cx = x + 30 * scale, cy = y + 28 * scale;
        const r = (12 + Math.sin(phase) * 1.2) * scale;
        for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4 + phase * 0.15;
            cv.line(cx + Math.cos(a) * 17 * scale, cy + Math.sin(a) * 17 * scale,
                cx + Math.cos(a) * 22 * scale, cy + Math.sin(a) * 22 * scale, 2 * scale, '#f4c95d');
        }
        cv.circle(cx, cy, r, '#f4c95d');
    }
    if (cloudy) {
        const cx = x + (sun ? 36 : 31) * scale, cy = y + 35 * scale;
        cv.circle(cx - 11 * scale, cy, 10 * scale, '#d4e0e8');
        cv.circle(cx, cy - 5 * scale, 14 * scale, '#e5edf2');
        cv.circle(cx + 13 * scale, cy + 1 * scale, 9 * scale, '#d4e0e8');
        cv.roundRect(cx - 19 * scale, cy, 39 * scale, 12 * scale, 6 * scale, '#d4e0e8');
    }
    if (rain || snow) {
        for (let i = 0; i < 3; i++) {
            const px = x + (18 + i * 13) * scale;
            const py = y + (53 + ((phase * 8 + i * 11) % 10)) * scale;
            if (snow) {
                cv.circle(px, py, 2 * scale, '#b8e8ff');
            } else {
                cv.line(px, py, px - 3 * scale, py + 7 * scale, 2 * scale, '#7dc7ee');
            }
        }
    }
}

function frame(cv, w, h) {
    cv.clear('#0d1720');
    cv.roundRect(2, 2, w - 4, h - 4, 14, '#101d27');
    return cv;
}

function drawWidget(ctx, snap) {
    const cv = frame(widgetCanvas, W, H), d = snap.data, now = Date.now() / 1000;
    cv.text('WEATHER', 36, 49, 14, '#9eafba', { font: 'bold', spacing: 1 });
    if (!d) {
        cv.text(snap.error || 'Loading...', 36, 100, 18, '#e6edf2', { font: 'bold' });
        cv.text(snap.detail || 'Internet Uplink', 36, 130, 13, '#91a2ad');
        return cv.canvas;
    }
    const c = d.current, daily = d.daily;
    icon(cv, c.weather_code, 35, 49, 1.0, now);
    cv.text(temp(c.temperature_2m, snap.unit), 113, 102, 44, '#f2f5f6', { font: 'light' });
    cv.text(describe(c.weather_code), 36, 131, 16, '#d9e1e6');
    cv.text('Feels ' + temp(c.apparent_temperature, snap.unit) + '  Wind ' + Math.round(c.wind_speed_10m) + ' km/h', 36, 153, 12, '#9eafb9');
    cv.line(36, 164, W - 36, 164, 1, '#33434e');
    const days = daily.time || [];
    for (let i = 0; i < Math.min(3, days.length); i++) {
        const x = 37 + i * 105;
        const day = new Date(days[i] + 'T12:00:00');
        const label = i === 0 ? 'TODAY' : ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][day.getDay()];
        cv.text(label, x, 184, 11, '#8fa1ac', { font: 'bold' });
        cv.text(temp(daily.temperature_2m_max[i], snap.unit), x, 209, 17, '#edf2f5', { font: 'bold' });
        cv.text(temp(daily.temperature_2m_min[i], snap.unit), x + 41, 209, 15, '#92a3ad');
    }
    cv.text(snap.error ? 'Offline' : snap.source, 344, 49, 11, '#71838e', { align: 'right' });
    return cv.canvas;
}

function drawScreen(ctx, snap) {
    const cv = frame(ctx.canvas(1600, 520), 1600, 520), d = snap.data, now = Date.now() / 1000;
    cv.text('WEATHER', 58, 84, 22, '#9eafba', { font: 'bold', spacing: 2 });
    if (!d) {
        cv.text(snap.error || 'Loading weather…', 60, 190, 38, '#e6edf2', { font: 'bold' });
        cv.text(snap.detail || 'Waiting for Internet Uplink', 62, 238, 20, '#9eafb9');
        return cv;
    }
    const c = d.current, daily = d.daily;
    icon(cv, c.weather_code, 62, 104, 2.3, now);
    cv.text(temp(c.temperature_2m, snap.unit), 250, 232, 92, '#f3f6f7', { font: 'light' });
    cv.text(describe(c.weather_code), 62, 358, 32, '#e1e8ec');
    cv.text('Feels ' + temp(c.apparent_temperature, snap.unit) + '     Humidity ' + Math.round(c.relative_humidity_2m) + '%     Wind ' + Math.round(c.wind_speed_10m) + ' km/h', 62, 408, 22, '#9eafb9');
    const days = daily.time || [];
    for (let i = 0; i < Math.min(5, days.length); i++) {
        const x = 740 + i * 164;
        const day = new Date(days[i] + 'T12:00:00');
        const label = i === 0 ? 'TODAY' : ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][day.getDay()];
        cv.roundRect(x, 112, 148, 276, 12, '#192832');
        cv.text(label, x + 18, 150, 17, '#91a3ad', { font: 'bold' });
        if (daily.weather_code[i] !== null) {
            icon(cv, daily.weather_code[i], x + 28, 173, 1.2, now + i);
            cv.text(describe(daily.weather_code[i]), x + 16, 275, 15, '#d9e1e6');
        }
        cv.text(temp(daily.temperature_2m_max[i], snap.unit), x + 18, 332, 26, '#f0f4f6', { font: 'bold' });
        cv.text(temp(daily.temperature_2m_min[i], snap.unit), x + 78, 332, 23, '#9eafb9');
        if (number(daily.precipitation_probability_max[i]) !== null)
            cv.text('Precip ' + daily.precipitation_probability_max[i] + '%', x + 18, 365, 14, '#83c6e9');
    }
    cv.text((snap.error ? 'Offline: ' + snap.detail : snap.source) + '  •  Updated ' + new Date(snap.updated).toLocaleTimeString(),
        1000, 468, 15, '#7f929e');
    return cv;
}

module.exports = { createModel, widgetSummary, drawWidget, drawScreen };
