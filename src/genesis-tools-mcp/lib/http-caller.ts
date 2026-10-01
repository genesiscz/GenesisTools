import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentCaller } from "@genesiscz/utils/agent/runtime";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { readProcessCwd } from "@genesiscz/utils/process/cwd";
import { findLoopbackClientPids, type ProcessInfo, readProcessInfo } from "@genesiscz/utils/process/socket-owner";

const log = logger.child({ component: "genesis-tools-mcp:http-caller" });

/** Executable names of the harnesses that speak MCP over HTTP to the gateway. */
const HARNESS_BY_NAME: Record<string, AgentCaller["agent"]> = {
    claude: "claude-code",
    codex: "codex",
    grok: "grok",
    copilot: "copilot",
};

/**
 * Claude Code writes `~/.claude/sessions/<pid>.json` for each running process and keeps
 * `sessionId` current. A pid is reused after its process exits, and a stale file can
 * outlive it, so the file counts only when its `startedAt` matches the process start.
 */
const START_TOLERANCE_SEC = 120;

interface ClaudeSessionFile {
    pid?: number;
    sessionId?: string;
    startedAt?: number;
}

export interface ResolvedCaller extends AgentCaller {
    pid: number | null;
    processName: string | null;
}

function claudeSessionId(info: ProcessInfo, sessionsDir: string): string | null {
    const path = join(sessionsDir, `${info.pid}.json`);
    let parsed: ClaudeSessionFile;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8")) as ClaudeSessionFile;
    } catch (error) {
        log.debug({ error, path }, "no readable claude session file for the caller pid");
        return null;
    }

    if (parsed.pid !== info.pid || typeof parsed.sessionId !== "string" || typeof parsed.startedAt !== "number") {
        return null;
    }

    if (Math.abs(parsed.startedAt / 1000 - info.startSec) > START_TOLERANCE_SEC) {
        log.warn({ pid: info.pid, path }, "claude session file belongs to an earlier process with this pid");
        return null;
    }

    return parsed.sessionId;
}

const UNKNOWN: ResolvedCaller = { agent: "unknown", sessionId: null, cwd: null, pid: null, processName: null };

/** The harness process that holds the client end of this connection, and what it is running. */
export function resolveCallerFromPeer(opts: {
    clientPort: number;
    serverPort: number;
    claudeSessionsDir?: string;
}): ResolvedCaller {
    const pids = findLoopbackClientPids({ clientPort: opts.clientPort, serverPort: opts.serverPort });
    const infos = pids.map(readProcessInfo).filter((info): info is ProcessInfo => info !== null);
    const harness = infos.find((info) => HARNESS_BY_NAME[info.name] !== undefined);
    const chosen = harness ?? (infos.length === 1 ? infos[0] : undefined);

    if (!chosen) {
        log.info({ clientPort: opts.clientPort, owners: pids }, "gateway caller has no single owning process");
        return UNKNOWN;
    }

    const agent = HARNESS_BY_NAME[chosen.name] ?? "unknown";
    const sessionId =
        agent === "claude-code"
            ? claudeSessionId(chosen, opts.claudeSessionsDir ?? join(homedir(), ".claude", "sessions"))
            : null;

    return {
        agent,
        sessionId,
        cwd: readProcessCwd(chosen.pid),
        pid: chosen.pid,
        processName: chosen.name,
    };
}
