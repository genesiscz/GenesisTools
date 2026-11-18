import { cpuMeta, profiler } from "@genesiscz/utils/profile";
import {
    readWidgetRoster,
    refreshWidgetIndex,
    WIDGET_EXACT_PATHS_LIMIT,
    type WidgetRoster,
    WidgetRosterReads,
    widgetRosterPaths,
} from "./roster-index";
import { streamWidgetRoster, updateRosterPaths } from "./roster-pages";
import type { WidgetRosterReply, WidgetRosterRequest } from "./roster-reader";

declare const self: Worker;
const prof = profiler.scope("widget");
const reads = new WidgetRosterReads();
let previous: WidgetRoster | undefined;
let pendingPage: { id: number; resume: () => void } | undefined;

self.onmessage = async (event: MessageEvent<WidgetRosterRequest | { id: number; received: true }>) => {
    if ("received" in event.data) {
        if (pendingPage?.id === event.data.id) {
            pendingPage.resume();
            pendingPage = undefined;
        }
        return;
    }
    const { id, index = [], paths = {}, parentPaths = [], onlyIfChanged = false } = event.data;
    try {
        let exact =
            (onlyIfChanged || parentPaths.length > 0) &&
            !reads.needed(false) &&
            index.every((scope) => {
                const files = paths[scope];
                return files && files.length > 0 && files.length <= WIDGET_EXACT_PATHS_LIMIT;
            });
        if (index.length > 0) {
            // Resident, so the walk and transcript caches stay warm: a refresh here costs a fraction of a new
            // `hub widget discover` process, which paid every cold cache on each run.
            let changed = true;
            const cpu = prof.enabled ? cpuMeta() : undefined;
            await prof.measureAsync(
                "background index",
                async () => {
                    changed = await refreshWidgetIndex(new Set(index), {
                        paths: widgetRosterPaths(paths),
                        onWholeListing: () => {
                            exact = false;
                        },
                    });
                },
                () => ({ ...cpu?.(), scopes: index.join(","), exact: Object.values(paths).flat().length, changed })
            );
            // This refresh writing nothing is not enough: another process may have written since the last read.
            if (onlyIfChanged && !reads.needed(changed)) {
                self.postMessage({ id, ok: true, unchanged: true } satisfies WidgetRosterReply);
                return;
            }
        }

        const sameIndex = reads.reading();
        const roster = await prof.measureAsync(
            "background roster",
            async () => {
                if (!previous?.rows.length) {
                    const revision = crypto.randomUUID();
                    return streamWidgetRoster(
                        (page) =>
                            new Promise<void>((resume) => {
                                pendingPage = { id, resume };
                                self.postMessage({ id, ok: true, page, revision } satisfies WidgetRosterReply);
                            })
                    );
                }
                if (exact && sameIndex) {
                    const update = await updateRosterPaths(
                        previous,
                        [...parentPaths, ...Object.values(paths).flat()],
                        Date.now()
                    );
                    if (update) {
                        return update;
                    }
                }
                return readWidgetRoster();
            },
            cpuMeta()
        );
        previous = roster;
        self.postMessage({ id, ok: true, ...roster } satisfies WidgetRosterReply);
    } catch (error) {
        self.postMessage({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        } satisfies WidgetRosterReply);
    }
};
