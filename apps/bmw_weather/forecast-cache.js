'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
const KAMCHATKA_OFFSET = 12 * 60 * 60 * 1000;
const DAILY_VALUES = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max'];

function localTime(timestamp) {
    return new Date(timestamp + KAMCHATKA_OFFSET).toISOString();
}

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validForecast(forecast) {
    if (!forecast || !forecast.current || !forecast.daily) return false;
    const daily = forecast.daily, dates = daily.time;
    return Number.isFinite(forecast.current.temperature_2m)
        && Number.isInteger(forecast.current.weather_code)
        && Array.isArray(dates) && dates.length > 0 && dates.length <= 3
        && dates.every((date, i) => validDate(date) && (i === 0 || dates[i - 1] < date))
        && DAILY_VALUES.every((key) => Array.isArray(daily[key]) && daily[key].length === dates.length
            && daily[key].every((value) => value === null || Number.isFinite(value)))
        && dates.every((_, i) => daily.temperature_2m_max[i] !== null || daily.temperature_2m_min[i] !== null);
}

function remainingDays(daily, today) {
    const index = daily.time.findIndex((date) => date >= today);
    if (index === 0) return daily;
    const first = index === -1 ? daily.time.length : index;
    const result = { time: daily.time.slice(first) };
    DAILY_VALUES.forEach((key) => { result[key] = daily[key].slice(first); });
    return result;
}

function createCache(dataDir, latitude, longitude, log) {
    const file = path.join(dataDir, 'forecast-cache.json');
    const temporary = file + '.tmp';
    return {
        read() {
            try {
                const record = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (record && record.version === CACHE_VERSION && record.latitude === latitude
                    && record.longitude === longitude && Number.isSafeInteger(record.updated)
                    && record.updated > 0 && Number.isFinite(new Date(record.updated + KAMCHATKA_OFFSET).getTime())
                    && validForecast(record.forecast)) return record;
            } catch (error) {
                if (error.code !== 'ENOENT') log.warn('Не удалось прочитать сохранённый прогноз: ' + error.message);
            }
            return null;
        },
        write(record) {
            try {
                const contents = { version: CACHE_VERSION, latitude, longitude, updated: record.updated, forecast: record.forecast };
                fs.writeFileSync(temporary, JSON.stringify(contents), { encoding: 'utf8', mode: 0o600 });
                fs.renameSync(temporary, file);
            } catch (error) {
                log.warn('Не удалось сохранить прогноз: ' + error.message);
            }
        },
    };
}

module.exports = { createCache, validForecast, remainingDays, localTime };
