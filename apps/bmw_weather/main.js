'use strict';

const mgu = require('./kit/mgu');
const weather = require('./weather');

mgu.run({
    async background(bg) {
        const model = weather.createModel(bg, bg.log);
        model.updateSettings();
        bg.settings.onChange(() => { model.updateSettings(); model.refresh(); });
        model.refresh();

        // MainApp may start the process for the home widget without opening its screen.
        // Keep weather fetching and widget drawing alive in that case as well.
        if (bg.widget) {
            const sent = Object.create(null);
            bg.widget.onChange(() => { Object.keys(sent).forEach((id) => { delete sent[id]; }); });
            bg.widget.loop(2, (inst) => {
                const snap = model.snapshot();
                const summary = weather.widgetSummary(snap);
                if (sent[inst.spawnId] !== summary) {
                    sent[inst.spawnId] = summary;
                    bg.widget.set(inst.spawnId, 'TextRecordings', summary, 'Text');
                }
                return weather.drawWidget(bg, snap);
            });
        }
        return model;
    },
    async start(ctx) {
        const model = ctx.background;
        ctx.ui.onClick('BTN_REFRESH', () => model.refresh());

        // The screen only draws while it is visible. Weather data is fetched on a separate timer.
        ctx.loop('MAIN', 8, () => ctx.ui.image('MAIN_GFX', weather.drawScreen(ctx, model.snapshot())));
    }
});
