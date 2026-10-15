import type { CapturedCommand } from "@app/cmux/lib/capture-journal";
import { agentKindFromLauncher } from "@app/cmux/lib/launchers";
import { loadPins } from "@genesiscz/utils/agent-sessions/pins";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { cmuxIdKey } from "@genesiscz/utils/cmux/lib/target";
import { loadAllSessionCmuxRefs, resolveRefsProvider } from "@genesiscz/utils/cmux/session-refs";
import { logger } from "@genesiscz/utils/logger";

export interface SurfaceSessionInfo {
    sessionId: string;
    account?: string;
    /**
     * Which agent this id belongs to. The cmux hook is shared, so the journal holds Codex and
     * Grok records too. A record with no `provider` predates the tag; it counts as Claude's
     * only when the id has Claude's own UUIDv4 shape (see `resolveRefsProvider` in
     * `@genesiscz/utils/cmux/session-refs`).
     *
     * 🛑 Load-bearing, not decoration: the replay path turns this id into a launch command, and
     * assuming "claude" replayed a Codex thread id as `claude -r <codex uuid>` — a session
     * Claude has never seen. That is the same defect the comment at `snapshot.ts` already
     * described for Grok, arriving through the journal instead of a tab title.
     */
    provider: AccountProviderAlias;
    /**
     * When the surface journal last saw this session in the tab (epoch ms). Absent for a session read off
     * a live process, which is running now.
     */
    at?: number;
    /** When the surface journal first saw this session in the tab (epoch ms). */
    firstAt?: number;
    /**
     * The newest session of each agent the journal saw in this tab, newest first; the fields above are the first
     * of them. A worker started inside the tab (a babysit grok, a Codex app-server) inherits the tab and can leave
     * the newest line, so `pickSurfaceSession` chooses among these by what the tab ran.
     */
    candidates?: SurfaceSessionInfo[];
}

/** When the journal saw the session; a session read off a live process (no `at`) runs now. */
function seenAt(session: SurfaceSessionInfo): number {
    return session.at ?? Number.POSITIVE_INFINITY;
}

/**
 * The session of the tab's own agent among the journal's candidates (Sonnet review F9 and F11, 2026-10-14):
 * - the typed command names an agent (`grok -r …`, `tools codex run …`): that agent's newest session, and only
 *   when the journal saw it after the command started. An older one belongs to an earlier run in the tab: resuming
 *   it under the new command's account opened another session's history (probe E of the review);
 * - otherwise (any alias, `cr work`, a shell function): of the sessions seen after the command started, the one the
 *   command started first, because workers start later, from inside it;
 * - no command, or nothing after it: the newest session.
 */
export function pickSurfaceSession(
    info: SurfaceSessionInfo | undefined,
    typed?: Pick<CapturedCommand, "command" | "atMs">
): SurfaceSessionInfo | undefined {
    if (!info || !typed) {
        return info;
    }

    const candidates = info.candidates ?? [info];
    const kind = agentKindFromLauncher(typed.command);

    if (kind) {
        return candidates.find((candidate) => candidate.provider === kind && seenAt(candidate) >= typed.atMs);
    }

    if (candidates.length < 2) {
        return info;
    }

    const after = candidates.filter((candidate) => seenAt(candidate) >= typed.atMs);

    if (after.length === 0) {
        return info;
    }

    return after.reduce((first, candidate) =>
        (candidate.firstAt ?? candidate.at ?? 0) < (first.firstAt ?? first.at ?? 0) ? candidate : first
    );
}

/** The drift line for a tab whose journal session `pickSurfaceSession` set aside as older than the typed launcher. */
export function staleSessionNote(
    recorded: SurfaceSessionInfo | undefined,
    picked: SurfaceSessionInfo | undefined,
    typed: Pick<CapturedCommand, "command"> | undefined
): string[] {
    if (!recorded || picked || !typed) {
        return [];
    }

    return [
        `the surface journal saw ${recorded.provider} session ${recorded.sessionId} here only before \`${typed.command.split("\n")[0].slice(0, 60)}\` started, so that session is not resumed`,
    ];
}

/** surface uuid (CMUX_SURFACE_ID) → newest known agent session + account. */
export async function loadSurfaceSessions(
    options: { beforeMs?: number; refsPath?: string; pinsPath?: string } = {}
): Promise<Map<string, SurfaceSessionInfo>> {
    type Candidate = {
        sessionId: string;
        account?: string;
        provider: AccountProviderAlias;
        at: number;
        firstAt?: number;
        ended?: boolean;
    };
    /** surface → provider → that provider's newest session in the tab. */
    const out = new Map<string, Map<AccountProviderAlias, Candidate>>();
    try {
        const refs = loadAllSessionCmuxRefs(options.refsPath, options);
        const pins = await loadPins({ readOnly: true, path: options.pinsPath });

        for (const entry of refs.values()) {
            if (!entry.surfaceId) {
                continue;
            }
            // The pin journal outranks the id shape. It is written per session by the same
            // SessionStart hook and names the provider outright, so it settles the ids the
            // v4/v7 habit gets wrong — the Codex rollouts from before its id switchover, and
            // Grok's worktree sessions, all of which are v4-shaped.
            const pin = pins.get(entry.sessionId);
            const provider = resolveRefsProvider(entry, pin);
            if (!provider) {
                logger.debug(
                    { sessionId: entry.sessionId, surfaceId: entry.surfaceId },
                    "[command-capture] untagged cmux ref with a non-Claude session id and no pin — skipped"
                );
                continue;
            }

            const key = cmuxIdKey(entry.surfaceId);
            const byProvider = out.get(key) ?? new Map<AccountProviderAlias, Candidate>();
            const existing = byProvider.get(provider);

            if (existing && existing.at >= (entry.at ?? 0)) {
                continue;
            }

            byProvider.set(provider, {
                sessionId: entry.sessionId,
                // Only this agent's own pin: an untagged pin is Claude's, and reading it for a
                // Codex surface would attach a Claude account to a Codex session.
                account: (pin?.provider ?? "claude") === provider ? (pin?.account ?? undefined) : undefined,
                provider,
                at: entry.at ?? 0,
                firstAt: entry.firstAt,
                ended: entry.ended,
            });
            out.set(key, byProvider);
        }
    } catch (error) {
        logger.warn({ error }, "[command-capture] session refs/pins unavailable");
    }

    const result = new Map<string, SurfaceSessionInfo>();
    const endedTabs: string[] = [];

    for (const [surface, byProvider] of out) {
        const newestFirst = [...byProvider.values()].sort((a, b) => b.at - a.at);

        // A tab whose last session was ended on purpose (`/exit`) has nothing to resume: the newest record
        // decides, so an older session of the same tab does not come back either.
        if (newestFirst[0]?.ended) {
            endedTabs.push(surface);
            continue;
        }

        const candidates = newestFirst
            .filter((candidate) => !candidate.ended)
            .map(({ sessionId, account, provider, at, firstAt }) => ({ sessionId, account, provider, at, firstAt }));
        result.set(surface, { ...candidates[0], ...(candidates.length > 1 ? { candidates } : {}) });
    }

    if (endedTabs.length > 0) {
        logger.debug({ surfaces: endedTabs }, "[command-capture] tabs whose session was ended on purpose");
    }

    return result;
}

/** session id → pinned account, for ids the process table (not the journal) supplied. */
export async function loadPinnedAccounts(sessionIds: Iterable<string>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
        const pins = await loadPins({ readOnly: true });
        for (const sessionId of sessionIds) {
            const account = pins.get(sessionId)?.account;
            if (account) {
                out.set(sessionId, account);
            }
        }
    } catch (error) {
        logger.warn({ error }, "[command-capture] session pins unavailable");
    }

    return out;
}
