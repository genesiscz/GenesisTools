import { loadEvents } from "./load";
import type { LoadJob, LoadJobResult } from "./load-parallel";

declare const self: Worker;

/**
 * One source group's transcript load, on its own thread. `loadEvents` reads and parses with
 * synchronous file calls, so the groups only overlap when each has a thread of its own.
 */
self.onmessage = (event: MessageEvent<LoadJob>) => {
    try {
        self.postMessage({ ok: true, events: loadEvents(event.data.options) } satisfies LoadJobResult);
    } catch (err) {
        self.postMessage({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        } satisfies LoadJobResult);
    }
};
