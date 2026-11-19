import type { WatchDriver } from "./types";

/** The Parcel driver is not built yet: it answers that it is not available and opens nothing. */
export function parcelDriver(_options: { maxEvents?: number } = {}): WatchDriver {
    return {
        facts: { outlivesProcess: false, fence: "own-cookie", fencesLinkedWorktrees: false },
        available: async () => ({ ok: false, reason: "not-built" }),
        open: async () => ({ ok: false, reason: "open-failed", detail: "not-built" }),
        dispose: async () => {},
    };
}
