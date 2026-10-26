import { modsSettings } from "./settings";

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

let dueAt: number | undefined;

/** When the armed idle compaction fires (ms since the epoch), or `undefined` while none will: the cache band shows it. */
export function idleDueAt(): number | undefined {
    return dueAt;
}

export function setIdleDueAt(at: number | undefined): void {
    dueAt = at;
}

/** An older usage lookup must not publish a countdown after its timer was cancelled or replaced. */
export async function publishIdleDue({
    current,
    tokens,
    minTokens,
    at,
}: {
    current: () => boolean;
    tokens: Promise<number | undefined>;
    minTokens: number;
    at: number;
}): Promise<void> {
    const count = await tokens;
    if (current()) {
        setIdleDueAt(count === undefined || count >= minTokens ? at : undefined);
    }
}

/** The start of the notice the mod appends. GenesisClaude's session-analyzer `idle-compact.ts scan` counts it. */
export const IDLE_NOTICE = "Compacted while idle";

/**
 * `mods.idleCompact` of the hooks file: `{ enabled, minutes, minTokens }`, or the flat `mods.idleCompact`,
 * `mods.idleCompactMinutes` and `mods.idleCompactMinTokens` of before 2026-10-23
 * (`tools agents hooks config set mods.idleCompact.enabled false --write`). A missing or broken file, and a value
 * of the wrong kind, leave that value's default.
 */
export function idleCompactSettings(hooksFile: string | undefined): IdleCompactSettings {
    return modsSettings(hooksFile).idleCompact;
}

/**
 * Whether a compaction leaves nothing for the timer to save: a main-loop one that ran. A `precompute`
 * installs nothing (the engine keeps its summary for a later threshold compaction), and it resolves after
 * the turn that started it, so cancelling on it would drop the timer of exactly the largest sessions.
 */
export function compactionEndsIdleWait({
    agentId,
    trigger,
    skipped,
}: {
    agentId: string | undefined;
    trigger: string;
    skipped: boolean;
}): boolean {
    return agentId === undefined && trigger !== "precompute" && !skipped;
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
        return "mods.idleCompact.enabled is off";
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
