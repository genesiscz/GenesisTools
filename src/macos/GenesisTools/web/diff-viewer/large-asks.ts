/** How long an ask for a large file waits for the file or for the host's refusal before it ends on its own. */
export const LARGE_ASK_DEADLINE_MS = 60_000;

export interface LargeAskDeps {
    log: (message: string) => void;
    setTimeout: (callback: () => void, ms: number) => number;
    clearTimeout: (id: number) => void;
    /** An ask ended without its file (the host refused or failed it, or the deadline passed): redraw its button. */
    onEnd: (fileId: string) => void;
    deadlineMs?: number;
}

export interface LargeAsks {
    /** Starts an ask for this file. False when one is already open: a second click asks nothing. */
    ask(fileId: string): boolean;
    /** Whether this file has an open ask: its button reads "Loading…". */
    isAsked(fileId: string): boolean;
    /** Why this file's last ask ended without the file, until the next ask or the file's arrival. */
    lastFailure(fileId: string): string | undefined;
    /** The file arrived whole: its ask is done, and the last failure is forgotten. */
    arrived(fileId: string): void;
    /** The host refused or failed this file's ask. False when no ask is open: a stale reply changes nothing. */
    failed(fileId: string, reason: string): boolean;
}

/**
 * The page's asks for files skipped for their size (the "Show whole file" button, the note line and its "+"). One ask
 * per file at a time, and every ask ends: the file arrives whole, the host answers `largeFailed`, or the deadline
 * passes. A button never stays on "Loading…" after a failed git read or a host that dropped the ask (2026-11-10,
 * PR #756 review: the latch was cleared only by the file's arrival).
 */
export function createLargeAsks(deps: LargeAskDeps): LargeAsks {
    const deadlineMs = deps.deadlineMs ?? LARGE_ASK_DEADLINE_MS;
    const open = new Map<string, number>();
    const failures = new Map<string, string>();

    function end(fileId: string, reason: string): boolean {
        const timer = open.get(fileId);

        if (timer === undefined) {
            return false;
        }

        deps.clearTimeout(timer);
        open.delete(fileId);
        failures.set(fileId, reason);
        deps.log(`diff.large ask for ${fileId} ended without the file: ${reason}`);
        deps.onEnd(fileId);
        return true;
    }

    return {
        ask(fileId) {
            if (open.has(fileId)) {
                return false;
            }

            failures.delete(fileId);
            const timer = deps.setTimeout(
                () => end(fileId, `no answer in ${Math.round(deadlineMs / 1000)} s`),
                deadlineMs
            );
            open.set(fileId, timer);
            return true;
        },
        isAsked: (fileId) => open.has(fileId),
        lastFailure: (fileId) => failures.get(fileId),
        arrived(fileId) {
            const timer = open.get(fileId);

            if (timer !== undefined) {
                deps.clearTimeout(timer);
                open.delete(fileId);
            }

            failures.delete(fileId);
        },
        failed: (fileId, reason) => end(fileId, reason),
    };
}
