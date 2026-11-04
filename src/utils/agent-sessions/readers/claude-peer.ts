import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSessionsDir } from "@genesiscz/utils/claude/peer-message";
import type { PeerProcess } from "@genesiscz/utils/harness/parts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("agent-context");

/**
 * Claude Code writes `~/.claude/sessions/<pid>.json` for each running process and keeps `sessionId` current. A pid is
 * reused after its process exits, and a stale file can outlive it, so the file counts only when its `startedAt`
 * matches the process start.
 */
const START_TOLERANCE_SEC = 120;

interface ClaudeSessionFile {
    pid?: number;
    sessionId?: string;
    startedAt?: number;
}

/** The session a running Claude Code process works in, from its session registry; null when no fresh file names it. */
export function claudePeerSession(process: PeerProcess, registryDir: string = claudeSessionsDir()): string | null {
    const path = join(registryDir, `${process.pid}.json`);
    let parsed: ClaudeSessionFile;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8")) as ClaudeSessionFile;
    } catch (error) {
        log.debug({ error, path }, "no readable claude session file for the caller pid");
        return null;
    }

    if (parsed.pid !== process.pid || typeof parsed.sessionId !== "string" || typeof parsed.startedAt !== "number") {
        return null;
    }

    if (Math.abs(parsed.startedAt / 1000 - process.startSec) > START_TOLERANCE_SEC) {
        log.warn({ pid: process.pid, path }, "claude session file belongs to an earlier process with this pid");
        return null;
    }

    return parsed.sessionId;
}
