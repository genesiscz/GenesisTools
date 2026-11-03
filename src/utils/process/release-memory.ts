/**
 * Caches a resident process can drop and rebuild on its next ask. A long-lived server (the hub server) calls
 * `releaseMemory()` when it runs over its memory cap, before it decides to restart: a restart drops the same caches
 * and the whole process with them, so the next ask pays the cold cost anyway, and then the process start too.
 *
 * Measured 2026-11-03: one hub Changes-pane ask of a 329 MB session keeps about 130 MB of transcript folds and
 * shell-call analyses after a GC; with a 250 to 320 MB baseline the server crossed its 512 MB cap and restarted, and
 * the restarted server folded the session cold again on the next ask (four restarts in two hours).
 */
const releasers = new Map<string, () => void>();

/** Register a cache's release under a stable name; a second registration under the same name replaces the first. */
export function onReleaseMemory(name: string, release: () => void): void {
    releasers.set(name, release);
}

/** Drop every registered cache. Returns the names released, in registration order. */
export function releaseMemory(): string[] {
    for (const release of releasers.values()) {
        release();
    }

    return [...releasers.keys()];
}
