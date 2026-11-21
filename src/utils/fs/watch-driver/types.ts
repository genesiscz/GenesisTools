/** One path a watcher saw change. A driver only names paths to ask Git about again; it never supplies a status entry. */
export interface WatchChange {
    /** Relative to the root, forward slashes. */
    path: string;
    exists: boolean;
}

export const WATCH_LOSSES = [
    "fresh-instance",
    "recrawl",
    "overflow",
    "fence-timeout",
    "closed",
    "driver-error",
] as const;
export type WatchLoss = (typeof WATCH_LOSSES)[number];

export type WatchChanges =
    | { kind: "changes"; clock: string; changes: WatchChange[]; fenceMs: number }
    | { kind: "lost"; reason: WatchLoss; detail?: string };

export interface WatchedRoot {
    /** Changes when a new daemon or stream replaced the one that made earlier clocks. */
    readonly instance: string;
    /** A synchronized boundary now, and every path with an event after `since`. `since: null`: the boundary only. */
    changesSince(since: string | null, options: { fenceMs: number; signal?: AbortSignal }): Promise<WatchChanges>;
    /** Stops what this process owns. Never deletes a watch another program may use. */
    close(): Promise<void>;
}

export type WatchOpen =
    | { ok: true; watched: WatchedRoot }
    | { ok: false; reason: "not-installed" | "unsupported-root" | "open-failed"; detail: string };

export interface WatchDriverFacts {
    /** A daemon holds the watch and its history, so they outlive this process. */
    readonly outlivesProcess: boolean;
    readonly fence: "daemon-cookie" | "own-cookie";
    /** A linked worktree (its `.git` is a file) can be fenced. */
    readonly fencesLinkedWorktrees: boolean;
}

export interface WatchDriver {
    readonly facts: WatchDriverFacts;
    /** Reads only: the binary or the native module is there. Opens nothing. */
    available(): Promise<{ ok: true; version: string } | { ok: false; reason: string }>;
    /** `gitDir` and the driver's own cookies are never reported as changes. */
    open(spec: { root: string; gitDir: string }): Promise<WatchOpen>;
    dispose(): Promise<void>;
}
