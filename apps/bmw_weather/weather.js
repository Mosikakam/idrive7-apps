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

function weatherError(message, code = 'EWEATHER') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function requestJson(hostname, path, lookup) {
    return new Promise((resolve, reject) => {
        let phase = 'разрешение имени DNS', finished = false, deadline, tcpDeadline;
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
                    phase = 'подключение по TCP';
                    tcpDeadline = setTimeout(() => {
                        req.destroy(weatherError('Тайм-аут подключения по TCP', 'EWEATHERTCP'));
                    }, 15000);
                }
                callback(err, address, family);
            });
        }
        // MGU runs Node.js 8. The (url, options, callback) overload needs Node.js 10.9+.
        const req = https.get({ hostname, path, lookup: tracedLookup,
            headers: { 'User-Agent': 'BMW-MGU-Weather/1.0', 'Accept': 'application/json' } }, (res) => {
            phase = 'получение данных (0 байт)';
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
                phase = 'получение данных (' + body.length + ' симв.)';
                if (body.length > 200000) req.destroy(weatherError('Ответ сервиса слишком большой'));
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return complete(weatherError('Сервис вернул HTTP ' + res.statusCode));
                try { complete(null, JSON.parse(body)); }
                catch (e) { complete(weatherError('Некорректный ответ сервиса')); }
            });
            res.on('error', complete);
        });
        req.on('socket', (socket) => {
            socket.on('connect', () => { clearTimeout(tcpDeadline); phase = 'установка защищённого соединения'; });
            socket.on('secureConnect', () => { phase = 'ожидание ответа'; });
        });
        req.setTimeout(12000, () => req.destroy(weatherError('Тайм-аут ожидания. Этап — ' + phase)));
        deadline = setTimeout(() => req.destroy(weatherError('Тайм-аут запроса. Этап — ' + phase)), 25000);
        req.on('error', complete);
    });
}

function failureText(e) {
    const code = e && e.code;
    if (/^(EWEATHER|EUPLINK)|^(EDNSTIMEOUT|ENODNS)$/.test(code || '')) return e.message;
    return code ? 'Ошибка сети (' + code + ')' : 'Не удалось получить данные о погоде';
}

const DESCRIPTIONS = {
    0: 'Ясно', 1: 'Преимущественно ясно', 2: 'Переменная облачность', 3: 'Пасмурно', 45: 'Туман',
    48: 'Морозный туман', 51: 'Слабая морось', 53: 'Морось', 55: 'Сильная морось',
    56: 'Ледяная морось', 57: 'Ледяная морось', 61: 'Небольшой дождь', 63: 'Дождь', 65: 'Сильный дождь',
    66: 'Ледяной дождь', 67: 'Ледяной дождь', 71: 'Небольшой снег', 73: 'Снег', 75: 'Сильный снег',
    77: 'Снежная крупа', 80: 'Кратковременный дождь', 81: 'Ливень', 82: 'Сильный ливень',
    85: 'Снегопад', 86: 'Сильный снегопад', 95: 'Гроза', 96: 'Гроза', 99: 'Гроза'
};

function number(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function describe(code) { return DESCRIPTIONS[code] || 'Погода'; }
function temp(v, unit) {
    if (number(v) === null) return '--°';
    const n = unit === 'f' ? v * 9 / 5 + 32 : v;
    return Math.round(n) + '°';
}

function createModel(ctx, log) {
    let data = null, error = 'Загрузка погоды…', detail = '', updated = 0;
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
            log.info('Погода обновлена через ' + source);
        } catch (e) {
            error = 'Погода недоступна';
            detail = failureText(e);
            detail = detail.slice(0, 90);
            log.warn(detail + '\n' + (e.stack || e));
        } finally { refreshing = false; }
    }
    const timer = setInterval(() => { if (Date.now() - lastAttempt >= refreshMs) refresh(); }, 60000);
    if (timer.unref) timer.unref();
    return {
        refresh, updateSettings,
        snapshot() { return { data, error, detail, updated, unit, source }; }
    };
}

function isRain(code) { return code >= 51 && code <= 67 || code >= 80 && code <= 82 || code >= 95; }
function isSnow(code) { return code >= 71 && code <= 77 || code === 85 || code === 86; }

function icon(cv, code, x, y, scale, phase) {
    const rain = isRain(code);
    const snow = isSnow(code);
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

function fittedSize(cv, text, size, available) {
    const width = cv.textWidth(text, size);
    return width > available ? size * available / width : size;
}

function widgetIcon(cv, code, now) {
    const x = 116, y = 126;
    if (code === 0 || code === 1) {
        const yellow = '#f4c15b';
        const pulse = Math.sin(now * 1.6);
        cv.arc(x, y, 30 + pulse * 2, 39 + pulse * 2, 0, 360, yellow);
        for (let i = 0; i < 8; i++) {
            const angle = i * Math.PI / 4 + pulse * 0.1;
            const dx = Math.cos(angle), dy = Math.sin(angle);
            const radius = 76 + pulse * 2;
            cv.line(x + 54 * dx, y + 54 * dy, x + radius * dx, y + radius * dy, 8, yellow);
        }
        return;
    }
    const scale = 3.35, drift = Math.sin(now * 1.2) * 5;
    const middle = isRain(code) || isSnow(code) ? 43 : 34;
    icon(cv, code, x - 31 * scale + drift, y - middle * scale, scale, now);
}

function drawWidget(snap, now = Date.now() / 1000) {
    const cv = widgetCanvas.clear('#050505'), d = snap.data;
    if (!d) {
        cv.text(snap.error || 'Загрузка погоды…', W / 2, H / 2, 23, '#e6edf2',
            { font: 'bold', align: 'center' });
        return cv.canvas;
    }
    const c = d.current, daily = d.daily;
    const left = 211, right = W - 36;
    const condition = describe(c.weather_code);
    widgetIcon(cv, c.weather_code, now);
    cv.text(temp(c.temperature_2m, snap.unit), right, 113, 68, '#f2f5f6', { font: 'light', align: 'right' });
    cv.text(condition, right, 143, fittedSize(cv, condition, 20, right - left), '#cbd8de', { align: 'right' });
    if (daily.time.length) {
        const range = temp(daily.temperature_2m_max[0], snap.unit) + ' / ' + temp(daily.temperature_2m_min[0], snap.unit);
        cv.line(left, 162, right, 162, 1, '#344650');
        cv.text(snap.error ? 'РАНЕЕ' : 'СЕГОДНЯ', left, 187, 12, '#93a6b2', { font: 'bold' });
        cv.text(range, right, 187, 16, '#edf4f7', { align: 'right' });
    }
    return cv.canvas;
}

function drawScreen(ctx, snap) {
    const cv = frame(ctx.canvas(1600, 520), 1600, 520), d = snap.data, now = Date.now() / 1000;
    cv.text('ПОГОДА', 58, 84, 22, '#9eafba', { font: 'bold', spacing: 2 });
    if (!d) {
        cv.text(snap.error || 'Загрузка погоды…', 60, 190, 38, '#e6edf2', { font: 'bold' });
        cv.text(snap.detail || 'Ожидание подключения к интернету', 62, 238, 20, '#9eafb9');
        return cv;
    }
    const c = d.current, daily = d.daily;
    icon(cv, c.weather_code, 62, 104, 2.3, now);
    cv.text(temp(c.temperature_2m, snap.unit), 250, 232, 92, '#f3f6f7', { font: 'light' });
    cv.text(describe(c.weather_code), 62, 358, 32, '#e1e8ec');
    cv.text('Ощущается ' + temp(c.apparent_temperature, snap.unit) + '     Влажность ' +
        Math.round(c.relative_humidity_2m) + '%     Ветер ' + Math.round(c.wind_speed_10m) + ' км/ч', 62, 408, 22, '#9eafb9');
    const days = daily.time || [];
    for (let i = 0; i < Math.min(5, days.length); i++) {
        const x = 740 + i * 164;
        const day = new Date(days[i] + 'T12:00:00');
        const label = i === 0 ? 'СЕГОДНЯ' : ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'][day.getDay()];
        cv.roundRect(x, 112, 148, 276, 12, '#192832');
        cv.text(label, x + 18, 150, 17, '#91a3ad', { font: 'bold' });
        if (daily.weather_code[i] !== null) {
            icon(cv, daily.weather_code[i], x + 28, 173, 1.2, now + i);
            const condition = describe(daily.weather_code[i]);
            cv.text(condition, x + 16, 275, fittedSize(cv, condition, 15, 116), '#d9e1e6');
        }
        cv.text(temp(daily.temperature_2m_max[i], snap.unit), x + 18, 332, 26, '#f0f4f6', { font: 'bold' });
        cv.text(temp(daily.temperature_2m_min[i], snap.unit), x + 78, 332, 23, '#9eafb9');
        if (number(daily.precipitation_probability_max[i]) !== null)
            cv.text('Осадки ' + daily.precipitation_probability_max[i] + '%', x + 18, 365, 14, '#83c6e9');
    }
    const updated = new Date(snap.updated);
    const time = String(updated.getHours()).padStart(2, '0') + ':' + String(updated.getMinutes()).padStart(2, '0');
    const status = snap.error ? 'Без сети. ' + snap.detail : snap.source;
    cv.text(status + '  /  Обновлено в ' + time, 1510, 468, 15, '#7f929e', { align: 'right' });
    return cv;
}

module.exports = { createModel, drawWidget, drawScreen };
