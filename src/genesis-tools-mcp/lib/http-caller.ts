import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentCaller } from "@genesiscz/utils/agent/runtime";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { readProcessCwd } from "@genesiscz/utils/process/cwd";
import {
    findLoopbackClientPids,
    type ProcessInfo,
    readOpenFilePaths,
    readProcessInfo,
} from "@genesiscz/utils/process/socket-owner";

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

const ROLLOUT_FILE =
    /\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Codex writes each thread to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` and
 * keeps that file open while the thread runs (observed on codex-cli 0.159.2). One open rollout names
 * the thread; several (an app-server running many threads) name none, because the socket alone
 * cannot say which thread made the call.
 */
export function codexThreadIdFromOpenFiles(paths: string[]): string | null {
    const ids = new Set<string>();
    for (const path of paths) {
        const match = path.match(ROLLOUT_FILE);
        if (match?.[1]) {
            ids.add(match[1].toLowerCase());
        }
    }

    return ids.size === 1 ? [...ids][0] : null;
}

function sessionIdFor(agent: AgentCaller["agent"], info: ProcessInfo, claudeSessionsDir: string): string | null {
    if (agent === "claude-code") {
        return claudeSessionId(info, claudeSessionsDir);
    }

    if (agent === "codex") {
        return codexThreadIdFromOpenFiles(readOpenFilePaths(info.pid));
    }

    return null;
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
    const sessionId = sessionIdFor(agent, chosen, opts.claudeSessionsDir ?? join(homedir(), ".claude", "sessions"));

    return {
        agent,
        sessionId,
        cwd: readProcessCwd(chosen.pid),
        pid: chosen.pid,
        processName: chosen.name,
    };
}
