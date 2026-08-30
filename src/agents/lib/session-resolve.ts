import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentSessionIds, assignedSessionId } from "@genesiscz/utils/agent-host";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { FriendlyError } from "./errors";
import { agentsRoot } from "./paths";

const SINGLE_RECENT_WINDOW_MS = 60_000;

const log = logger.child({ component: "agents:session-resolve" });

export interface SessionResolveResult {
    session: string;
    source: "explicit" | "env" | "host-swarm" | "host-new" | "single-recent";
    note?: string;
}

function assignedSession(): string | null {
    // Routed through the env facade so env.testing.set()/withOverrides() stays
    // the single override mechanism, instead of a parallel process.env read.
    return assignedSessionId(env.getProcessEnv());
}

function swarmExists(session: string): boolean {
    return existsSync(join(agentsRoot(), session));
}

/**
 * The swarm to join when nobody assigned one.
 *
 * A worker inherits its parent's environment, so several host ids can be present
 * at once: a codex worker spawned from Claude Code sees both CLAUDE_CODE_SESSION_ID
 * and CODEX_THREAD_ID. Binding to its own id would start an orphan swarm that the
 * parent is not in, so an id whose swarm directory ALREADY EXISTS always wins.
 * Only when none exists do we take the first present id and create a swarm, which
 * is the normal path for a fresh main session.
 */
function hostSession(): { session: string; source: "host-swarm" | "host-new" } | null {
    const candidates = agentSessionIds(env.getProcessEnv());

    const live = candidates.find((c) => swarmExists(c.id));
    if (live) {
        log.debug({ session: live.id, agent: live.agent, key: live.key }, "bound to an existing swarm");
        return { session: live.id, source: "host-swarm" };
    }

    const first = candidates[0];
    if (first) {
        log.debug({ session: first.id, agent: first.agent, key: first.key }, "no existing swarm, creating one");
        return { session: first.id, source: "host-new" };
    }

    return null;
}

function singleRecentSession(): string | null {
    const root = agentsRoot();

    if (!existsSync(root)) {
        return null;
    }

    const entries = readdirSync(root);
    const now = Date.now();
    const recent: string[] = [];

    for (const entry of entries) {
        if (entry.startsWith("_")) {
            continue;
        }

        const sessionDir = join(root, entry);
        let stat: ReturnType<typeof statSync>;

        try {
            stat = statSync(sessionDir);
        } catch (err) {
            log.debug({ err, sessionDir }, "skipping unreadable session directory during single-recent probe");
            continue;
        }

        if (!stat.isDirectory()) {
            continue;
        }

        const feed = join(sessionDir, "feed.jsonl");

        if (!existsSync(feed)) {
            continue;
        }

        const feedStat = statSync(feed);

        if (now - feedStat.mtimeMs < SINGLE_RECENT_WINDOW_MS) {
            recent.push(entry);
        }
    }

    if (recent.length === 1) {
        return recent[0] ?? null;
    }

    return null;
}

export function resolveSession(explicit: string | undefined): SessionResolveResult {
    if (explicit && explicit.trim().length > 0) {
        return { session: explicit.trim(), source: "explicit" };
    }

    const assigned = assignedSession();

    if (assigned) {
        return { session: assigned, source: "env" };
    }

    const host = hostSession();

    if (host) {
        return host;
    }

    const singleRecent = singleRecentSession();

    if (singleRecent) {
        const note = `auto-bound to session "${singleRecent}" (only recent active session in last 60s)`;
        log.debug({ singleRecent }, note);
        return { session: singleRecent, source: "single-recent", note };
    }

    throw new FriendlyError(
        "could not resolve a session: --session was not given, $GENESIS_AGENTS_SESSION / $GT_RENDEZVOUS_SESSION / $CLAUDE_CODE_SESSION_ID / $CODEX_THREAD_ID / $GROK_SESSION_ID are unset, and no other session has been active in the last 60s",
        "Pass --session <id> explicitly, OR set GENESIS_AGENTS_SESSION, OR run from a Claude Code / Codex / grok session, OR start a fresh swarm by running a login command with --session <id> first."
    );
}
