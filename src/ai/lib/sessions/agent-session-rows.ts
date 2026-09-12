import { loadPins } from "@app/claude/lib/cmux/pins";
import { cleanPromptText } from "@app/claude/lib/cmux/sessions";
import type { SessionPin } from "@app/claude/lib/cmux/types";
import { type CacheStatus, listSessionRows, type SessionCmuxLocation } from "@app/claude/lib/usage/session-rows";
import { openHistoryService } from "@genesiscz/utils/agent-sessions/open-service";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { grokAccountNameForHome } from "@genesiscz/utils/ai/providers/plugins/grok-sub/discover";
import { logger } from "@genesiscz/utils/logger";
import { collapsePath } from "@genesiscz/utils/paths";

/**
 * One session row for ANY coding agent, so a reader does not need a client per provider.
 *
 * `tools claude usage sessions --json` is the rich Claude-only surface and stays that way.
 * This adds Codex and Grok beside it, with the fields those providers genuinely have. The
 * Claude-only fields below are OPTIONAL rather than zero-filled: a cold-cache clock of `0`
 * reads as "expired right now", which is worse than showing nothing, and a consumer can test
 * for the field instead of having to know which providers compute it.
 */
export interface AgentSessionRow {
    /** `claude` | `codex` | `grok`. Which fields are present follows from this. */
    provider: AccountProviderAlias;
    sessionId: string;
    title: string | null;
    cwd: string;
    cwdShort: string;
    project: string | null;
    mtime: number;
    model: string | null;
    /**
     * The account this session bills, when it can be known.
     *
     * Claude and Codex: the SessionStart pin journal, which every agent's hook now writes.
     * Grok: the account whose login file the session's home holds.
     *
     * Codex records nothing of its own — every account shares one home, and neither a rollout
     * nor a `threads` row names an account. The pin is the only record, so a Codex session
     * started before the hook learned about Codex, or outside `tools codex run`, stays null.
     */
    account: string | null;
    filePath: string;
    /** Native home this session was read from. The only provenance Codex has. */
    sourceHome?: string;
    archived?: boolean;

    /** Claude only, from here down. Absent for Codex and Grok — never zero. */
    lastCacheAt?: number;
    cacheStatus?: CacheStatus;
    cacheTtlSec?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
    contextTokens?: number;
    compacted?: boolean;
    lastUserAt?: number | null;
    modelSwitched?: boolean;
    cmux?: SessionCmuxLocation | null;
}

export interface AgentSessionRowsOptions {
    /** Aliases to include. Omitted = all three. */
    providers?: readonly AccountProviderAlias[];
    /** Keep rows with mtime within this many hours. Omitted = no time filter. */
    hours?: number;
    /**
     * If the hours window has fewer rows, append older sessions by mtime.
     *
     * ⚠️ Claude only. `nativeRows()` never receives it, so Codex and Grok ignore it silently.
     * The CLI help says so; a programmatic caller reads this instead.
     */
    minRows?: number;
    limit?: number;
    now?: number;
}

const ALL: readonly AccountProviderAlias[] = ["claude", "codex", "grok"];

function titleOf(record: {
    customTitle: string | null;
    summary: string | null;
    firstPrompt: string | null;
}): string | null {
    const prompt = record.firstPrompt ? cleanPromptText(record.firstPrompt) : null;

    return record.customTitle ?? record.summary ?? (prompt && prompt.length > 0 ? prompt : null);
}

/** Grok names a login by its home; a home with no account simply has none. */
async function grokAccount(home: string): Promise<string | null> {
    return (await grokAccountNameForHome(home).catch(() => undefined)) ?? null;
}

/**
 * Grok can answer from the session's own home. Codex cannot answer at all on its own, so it
 * falls back to the SessionStart pin its launcher's `TOOLS_CODEX_ACCOUNT` produced.
 */
async function accountOf(
    alias: Exclude<AccountProviderAlias, "claude">,
    record: { sessionId: string | null; sourceHome?: string | null },
    pins: Map<string, SessionPin>
): Promise<string | null> {
    if (alias === "grok") {
        return record.sourceHome ? await grokAccount(record.sourceHome) : null;
    }

    return (record.sessionId ? pins.get(record.sessionId)?.account : null) ?? null;
}

/**
 * Codex and Grok rows, straight off the shared history index.
 *
 * `PR #370` made `openHistoryService` provider-generic; only `getSessionListing` in the Claude
 * tool stayed pinned to one provider, which is why nothing downstream of it had a Codex or
 * Grok equivalent.
 */
async function nativeRows(
    alias: Exclude<AccountProviderAlias, "claude">,
    options: AgentSessionRowsOptions
): Promise<AgentSessionRow[]> {
    // Read-only: a session listing is a diagnostic and must not rewrite the journal, and a
    // provider-filtered load must never compact it (see `loadPins`).
    const pins = await loadPins({ readOnly: true, provider: alias });
    const service = openHistoryService({ provider: PROVIDER_ALIASES[alias] });
    const { metadata } = await service.catalog({
        excludeAgents: true,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const cutoff = options.hours === undefined ? undefined : (options.now ?? Date.now()) - options.hours * 3_600_000;
    const rows: AgentSessionRow[] = [];

    for (const record of metadata) {
        if (!record.sessionId || (cutoff !== undefined && record.mtime < cutoff)) {
            continue;
        }

        const cwd = record.cwd ?? "";

        rows.push({
            provider: alias,
            sessionId: record.sessionId,
            title: titleOf(record),
            cwd,
            cwdShort: cwd ? collapsePath(cwd) : "",
            project: record.project,
            mtime: record.mtime,
            model: null,
            account: await accountOf(alias, record, pins),
            filePath: record.filePath,
            ...(record.sourceHome ? { sourceHome: record.sourceHome } : {}),
            archived: record.archived,
        });
    }

    return rows;
}

/** Every provider's sessions in one list, newest first. */
export async function listAgentSessionRows(options: AgentSessionRowsOptions = {}): Promise<AgentSessionRow[]> {
    const wanted = options.providers ?? ALL;
    const rows: AgentSessionRow[] = [];

    for (const alias of wanted) {
        try {
            if (alias === "claude") {
                const claude = await listSessionRows({
                    ...(options.hours === undefined ? {} : { hours: options.hours }),
                    ...(options.minRows === undefined ? {} : { minRows: options.minRows }),
                    ...(options.now === undefined ? {} : { now: options.now }),
                });

                rows.push(...claude.map((row) => ({ ...row, provider: "claude" as const })));
                continue;
            }

            rows.push(...(await nativeRows(alias, options)));
        } catch (error) {
            // One provider's index being unreadable must not blank the other two.
            logger.warn({ error, provider: alias }, "[ai] could not list this provider's sessions");
        }
    }

    rows.sort((a, b) => b.mtime - a.mtime);

    // Also after the merge: the per-provider limit reaches the catalog, but three capped lists
    // still add up to three times the cap, and the flag promises a row count.
    return options.limit === undefined ? rows : rows.slice(0, options.limit);
}
