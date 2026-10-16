/** The idle-compaction mod's settings, from the `mods` section of the hooks file. */
export interface IdleCompactSettings {
    enabled: boolean;
    /** Minutes after the last main-loop turn. Under 60, so the compaction still reads the 1-hour cache. */
    minutes: number;
    /** Below this many context tokens a compaction saves too little to pay for itself. */
    minTokens: number;
}

/**
 * 56 minutes: Claude Code's own idle compaction fires at 54 (0.9 of the hour) and goes first; the cache
 * written by the last request expires at 60. 200,000 tokens is the built-in's floor
 * (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` on this machine).
 */
export const IDLE_COMPACT_DEFAULTS: IdleCompactSettings = { enabled: true, minutes: 56, minTokens: 200_000 };

/** The start of the notice the mod appends. GenesisClaude's session-analyzer `idle-compact.ts scan` counts it. */
export const IDLE_NOTICE = "Compacted while idle";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function wholeIn(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * `mods.idleCompact`, `mods.idleCompactMinutes` and `mods.idleCompactMinTokens` from the hooks file
 * (`tools agents hooks config set mods.idleCompact false --write`). A missing or broken file, and a value
 * of the wrong kind, leave that value's default.
 */
export function idleCompactSettings(hooksFile: string | undefined): IdleCompactSettings {
    let mods: unknown;

    try {
        const stored: unknown = hooksFile === undefined ? undefined : JSON.parse(hooksFile);
        mods = isRecord(stored) ? stored.mods : undefined;
    } catch {
        mods = undefined;
    }

    const held = isRecord(mods) ? mods : {};

    return {
        enabled: typeof held.idleCompact === "boolean" ? held.idleCompact : IDLE_COMPACT_DEFAULTS.enabled,
        minutes: wholeIn(held.idleCompactMinutes, 1, 59) ? held.idleCompactMinutes : IDLE_COMPACT_DEFAULTS.minutes,
        minTokens: wholeIn(held.idleCompactMinTokens, 0, Number.MAX_SAFE_INTEGER)
            ? held.idleCompactMinTokens
            : IDLE_COMPACT_DEFAULTS.minTokens,
    };
}

/** Why the timer did not compact, or `undefined` to compact. */
export function idleCompactSkip({
    settings,
    surfaces,
    tokens,
}: {
    settings: IdleCompactSettings;
    surfaces: number;
    tokens: number | undefined;
}): string | undefined {
    if (!settings.enabled) {
        return "mods.idleCompact is off";
    }

    if (surfaces === 0) {
        return "no surface draws the session (claude -p)";
    }

    if (tokens === undefined || tokens < settings.minTokens) {
        return `context ${tokens ?? "unknown"} tokens, under the floor of ${settings.minTokens}`;
    }

    return undefined;
}

export function idleNotice({
    minutes,
    tokensBefore,
    tokensAfter,
}: {
    minutes: number;
    tokensBefore: number | undefined;
    tokensAfter: number | undefined;
}): string {
    const sizes =
        tokensBefore !== undefined && tokensAfter !== undefined
            ? ` (${tokensBefore.toLocaleString("en-US")} to ${tokensAfter.toLocaleString("en-US")} tokens)`
            : "";

    return `${IDLE_NOTICE}, before the prompt cache expired: genesis-tools-mods after ${minutes} min${sizes}`;
}
