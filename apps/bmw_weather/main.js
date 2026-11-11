'use strict';

const mgu = require('./kit/mgu');
const weather = require('./weather');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const model = weather.createModel(ctx, log);
        let busy = false;

        async function refresh() {
            if (busy) return;
            busy = true;
            try { await model.refresh(); }
            finally { busy = false; }
        }

        ui.onClick('BTN_REFRESH', () => refresh());
        settings.onChange(() => { model.updateSettings(); refresh(); });
        model.updateSettings();
        refresh();

        // The screen only draws while it is visible. Weather data is fetched on a separate timer.
        ctx.loop('MAIN', 8, () => ui.image('MAIN_GFX', weather.drawScreen(ctx, model.snapshot())));

        // BMW's startWidget surface, animated at a modest rate to keep rendering light.
        if (ctx.widget && ctx.widget.loop) {
            ctx.widget.loop(4, () => weather.drawWidget(ctx, model.snapshot()));
        }
    }
});
