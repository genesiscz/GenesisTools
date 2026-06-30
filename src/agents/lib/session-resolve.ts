import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { FriendlyError } from "./errors";
import { agentsRoot } from "./paths";

const SINGLE_RECENT_WINDOW_MS = 60_000;

const log = logger.child({ component: "agents:session-resolve" });

export interface SessionResolveResult {
    session: string;
    source: "explicit" | "env" | "single-recent";
    note?: string;
}

function envSession(): string | null {
    // Dynamic-key lookup (same helper used for ask ProviderConfig.envKey) routed
    // through the env facade so env.testing.set()/withOverrides() stays the
    // single override mechanism for this codebase, instead of a parallel
    // process.env read path.
    return env.ai.getByEnvKey("CLAUDE_CODE_SESSION_ID") ?? null;
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

    const fromEnv = envSession();

    if (fromEnv) {
        return { session: fromEnv, source: "env" };
    }

    const singleRecent = singleRecentSession();

    if (singleRecent) {
        const note = `auto-bound to session "${singleRecent}" (only recent active session in last 60s)`;
        log.debug({ singleRecent }, note);
        return { session: singleRecent, source: "single-recent", note };
    }

    throw new FriendlyError(
        "could not resolve a session: --session was not given, $CLAUDE_CODE_SESSION_ID is unset, and no other session has been active in the last 60s",
        "Pass --session <id> explicitly, OR set CLAUDE_CODE_SESSION_ID, OR start a fresh swarm by running a register/login command with --session <id> first."
    );
}
