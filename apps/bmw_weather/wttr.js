'use strict';

// Convert wttr.in's smaller format=j2 response to the fields drawn by Weather.
function value(v) {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
}

function code(v) {
    const n = Number(v);
    if (n === 113) return 0;
    if (n === 116) return 2;
    if (n === 119 || n === 122) return 3;
    if (n === 143 || n === 248 || n === 260) return 45;
    if ([200, 386, 389].indexOf(n) >= 0) return 95;
    if ([179, 182, 185, 227, 230, 323, 326, 329, 332, 335, 338, 350,
        362, 365, 368, 371, 374, 377, 392, 395].indexOf(n) >= 0) return 71;
    if (n >= 176 && n <= 320 || n >= 353 && n <= 359) return 61;
    return 3;
}

function convert(response) {
    const j = response && (response.data || response);
    const c = j && j.current_condition && j.current_condition[0];
    const days = j && j.weather;
    if (!c || !Array.isArray(days) || !days.length) throw new Error('wttr.in response incomplete');
    const current = {
        temperature_2m: value(c.temp_C),
        apparent_temperature: value(c.FeelsLikeC),
        relative_humidity_2m: value(c.humidity),
        wind_speed_10m: value(c.windspeedKmph),
        weather_code: code(c.weatherCode)
    };
    if (current.temperature_2m === null) throw new Error('wttr.in temperature missing');
    const daily = { time: [], weather_code: [], temperature_2m_max: [],
        temperature_2m_min: [], precipitation_probability_max: [] };
    days.slice(0, 5).forEach((day) => {
        const hours = Array.isArray(day.hourly) ? day.hourly : [];
        const noon = hours.filter((h) => Number(h.time) === 1200)[0] || hours[Math.floor(hours.length / 2)] || {};
        const precip = hours.reduce((all, h) => {
            const rain = value(h.chanceofrain), snow = value(h.chanceofsnow);
            if (rain !== null) all.push(rain);
            if (snow !== null) all.push(snow);
            return all;
        }, []);
        daily.time.push(day.date);
        daily.weather_code.push(hours.length ? code(noon.weatherCode) : null);
        daily.temperature_2m_max.push(value(day.maxtempC));
        daily.temperature_2m_min.push(value(day.mintempC));
        daily.precipitation_probability_max.push(precip.length ? Math.max.apply(null, precip) : null);
    });
    return { current, daily };
}

module.exports = { convert };
