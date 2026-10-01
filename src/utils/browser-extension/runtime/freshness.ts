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
