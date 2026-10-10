import { profiler } from "@genesiscz/utils/profile";
import { readWidgetRoster, refreshWidgetIndex } from "./roster-index";
import type { WidgetRosterReply, WidgetRosterRequest } from "./roster-reader";

declare const self: Worker;
const prof = profiler.scope("widget");

self.onmessage = async (event: MessageEvent<WidgetRosterRequest>) => {
    const { id, index = [], onlyIfChanged = false } = event.data;
    try {
        if (index.length > 0) {
            // Resident, so the walk and transcript caches stay warm: a refresh here costs a fraction of a new
            // `hub widget discover` process, which paid every cold cache on each run.
            let changed = true;
            await prof.measureAsync(
                "background index",
                async () => {
                    changed = await refreshWidgetIndex(new Set(index));
                },
                () => ({ scopes: index.join(","), changed })
            );
            if (onlyIfChanged && !changed) {
                self.postMessage({ id, ok: true, unchanged: true } satisfies WidgetRosterReply);
                return;
            }
        }

        const { rows, agents } = await prof.measureAsync("background roster", () => readWidgetRoster());
        self.postMessage({ id, ok: true, rows, agents } satisfies WidgetRosterReply);
    } catch (error) {
        self.postMessage({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        } satisfies WidgetRosterReply);
    }
};
