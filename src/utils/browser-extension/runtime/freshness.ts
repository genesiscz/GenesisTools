/**
 * Browser-side and pure: no Bun, no `chrome` global, so an extension bundle and a Bun test can both
 * import it. The build (`src/utils/browser-extension/build-info.ts`) compiles `__GT_BUILD__` in.
 */

/** Replaced at build time with the id of the build this code is. */
declare const __GT_BUILD__: string;

export const RUNNING_BUILD = typeof __GT_BUILD__ === "string" ? __GT_BUILD__ : "unbuilt";

/** What a host answers about the build in `dist`. */
export interface ExtensionStatus {
    /** The id compiled into the build in `dist`; null when there is none. */
    distBuildId: string | null;
    /** `dist` no longer matches the current sources or config: it needs a build. */
    stale: boolean;
    /** Short sha the running build was made from; null when the host cannot tell. */
    fromCommit?: string | null;
    /** Short sha an update would carry: the build in `dist` for a reload, the checkout HEAD for a rebuild. */
    toCommit?: string | null;
    /** Commits between `fromCommit` and `toCommit`. */
    behind?: number | null;
}

/**
 * `rebuild`: the sources or config changed since `dist` was built.
 * `reload`: `dist` is newer than the code this browser runs.
 */
export type Freshness = "current" | "reload" | "rebuild" | "unknown";

export function freshnessOf(running: string, status: ExtensionStatus): Freshness {
    if (status.stale) {
        return "rebuild";
    }

    return status.distBuildId === running ? "current" : "reload";
}

/** A host reply (`{ ok, data }`) read defensively: anything unexpected is `unknown`. */
export function freshnessFromReply(reply: { ok: boolean; data?: unknown }): Freshness {
    const data = reply.data;

    if (!reply.ok || typeof data !== "object" || data === null || Array.isArray(data)) {
        return "unknown";
    }

    const record: Record<string, unknown> = { ...data };
    const distBuildId = typeof record.distBuildId === "string" ? record.distBuildId : null;
    return freshnessOf(RUNNING_BUILD, { distBuildId, stale: record.stale === true });
}

export interface UpdateRange {
    fromCommit: string | null;
    toCommit: string | null;
    behind: number | null;
}

/** The commit range a host reply names, read defensively. */
export function updateRangeFromReply(reply: { ok: boolean; data?: unknown }): UpdateRange {
    const data = reply.data;
    const record: Record<string, unknown> =
        reply.ok && typeof data === "object" && data !== null && !Array.isArray(data) ? { ...data } : {};
    return {
        fromCommit: typeof record.fromCommit === "string" ? record.fromCommit : null,
        toCommit: typeof record.toCommit === "string" ? record.toCommit : null,
        behind: typeof record.behind === "number" ? record.behind : null,
    };
}

/** `abc1234 → def5678 (3 commits behind)`; null when the range is unknown. */
export function describeUpdateRange(range: UpdateRange): string | null {
    if (!range.fromCommit || !range.toCommit) {
        return null;
    }

    const from = range.fromCommit.slice(0, 7);
    const to = range.toCommit.slice(0, 7);

    if (from === to) {
        return `${from} (local changes)`;
    }

    const behind = range.behind ? ` (${range.behind} commit${range.behind === 1 ? "" : "s"} behind)` : "";
    return `${from} → ${to}${behind}`;
}
