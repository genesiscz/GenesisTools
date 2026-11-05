import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copilotHost } from "@genesiscz/utils/agent/hosts/copilot";
import { harnessDriver, harnessDrivers } from "@genesiscz/utils/ai/providers/harness-index";
import { claudeSessionsDir } from "@genesiscz/utils/claude/peer-message";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { readProcessCwd } from "@genesiscz/utils/process/cwd";
import {
    findLoopbackClientPids,
    type ProcessInfo,
    readOpenFilePaths,
    readProcessInfo,
} from "@genesiscz/utils/process/socket-owner";
import { profiler } from "@genesiscz/utils/profile";
import type { CallerAgent, PeerQuery } from "./types";

const { log } = logger.scoped("agent-context");
const prof = profiler.scope("agent-context");

/** A remote MCP caller as the gateway sees it: the process that holds the client end of the connection. */
export interface PeerCaller {
    agent: CallerAgent;
    sessionId: string | null;
    cwd: string | null;
    pid: number | null;
    processName: string | null;
}

/**
 * The executable name of each host that speaks MCP over HTTP to the gateway, and the runtime agent it reports: each
 * harness from its driver, Copilot from its host file.
 */
const AGENT_OF_BINARY: ReadonlyMap<string, CallerAgent> = new Map([
    ...harnessDrivers().map((driver): [string, CallerAgent] => [
        driver.identity.binary,
        harnessDriver(driver.id).parts.host.agent,
    ]),
    [copilotHost.binary, copilotHost.agent],
]);

/** The host chain's order (outer host first), used to pick among several host processes on one socket. */
const PRECEDENCE: readonly CallerAgent[] = [...AGENT_OF_BINARY.values()];

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

/** A plain or compressed rollout (Codex 0.164 compresses old ones to `.jsonl.zst`) under a `sessions/YYYY/MM/DD` folder. */
const ROLLOUT_FILE =
    /\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

/**
 * Codex writes each thread to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` and keeps that file
 * open while the thread runs (observed on codex-cli 0.159.2). One open rollout names the thread; several (an
 * app-server running many threads) name none, because the socket alone cannot say which thread made the call.
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

type SessionIdReader = (info: ProcessInfo, claudeSessionsDir: string) => string | null;

/**
 * How a calling process names its session: Claude by its session registry, Codex by the one rollout it holds open;
 * null where the process leaves no trace this lookup can read (Grok and Copilot keep their ids in a stdio child's
 * env). Keyed by runtime agent, the gateway's caller axis, and kept here rather than in the drivers: the readers spawn
 * `lsof` and read the session registry, which the hook-path drivers must not load.
 */
const SESSION_ID_OF: Record<CallerAgent, SessionIdReader | null> = {
    "claude-code": (info, sessionsDir) => claudeSessionId(info, sessionsDir),
    codex: (info) => codexThreadIdFromOpenFiles(readOpenFilePaths(info.pid)),
    grok: null,
    copilot: null,
    unknown: null,
};

/** Whether the gateway can name the session of a calling process of this runtime agent, so its MCP client may use HTTP. */
export function callerSessionReadable(agent: CallerAgent): boolean {
    return SESSION_ID_OF[agent] !== null;
}

const UNKNOWN: PeerCaller = { agent: "unknown", sessionId: null, cwd: null, pid: null, processName: null };

interface Candidate {
    info: ProcessInfo;
    agent: CallerAgent;
    sessionId: string | null;
}

/**
 * The one host process among several on the same socket, whatever order the kernel lists them in: a process that
 * names its session beats one that cannot (an inherited socket in a parent that left no trace), then the host chain's
 * order (outer host first), then the lower pid.
 */
function pickHost(candidates: Candidate[]): Candidate {
    return [...candidates].sort(
        (a, b) =>
            Number(b.sessionId !== null) - Number(a.sessionId !== null) ||
            PRECEDENCE.indexOf(a.agent) - PRECEDENCE.indexOf(b.agent) ||
            a.info.pid - b.info.pid
    )[0];
}

/** The host process that holds the client end of this connection, and what it is running. */
export function readPeerCaller(query: PeerQuery): PeerCaller {
    return prof.measure("gateway.resolveCallerFromPeer", () => {
        const pids = findLoopbackClientPids({ clientPort: query.clientPort, serverPort: query.serverPort });
        const infos = pids.map(readProcessInfo).filter((info): info is ProcessInfo => info !== null);
        const sessionsDir = query.claudeSessionsDir ?? claudeSessionsDir();
        const hosts: Candidate[] = infos.flatMap((info) => {
            const agent = AGENT_OF_BINARY.get(info.name);
            return agent ? [{ info, agent, sessionId: SESSION_ID_OF[agent]?.(info, sessionsDir) ?? null }] : [];
        });
        const lone = infos.length === 1 ? infos[0] : undefined;
        const chosen =
            hosts.length > 0 ? pickHost(hosts) : lone && { info: lone, agent: "unknown" as const, sessionId: null };

        if (!chosen) {
            log.info({ clientPort: query.clientPort, owners: pids }, "gateway caller has no single owning process");
            return UNKNOWN;
        }

        if (hosts.length > 1) {
            log.debug(
                { owners: hosts.map((host) => ({ pid: host.info.pid, agent: host.agent })), chosen: chosen.info.pid },
                "agent-context: several host processes share the caller's socket"
            );
        }

        return {
            agent: chosen.agent,
            sessionId: chosen.sessionId,
            cwd: readProcessCwd(chosen.info.pid),
            pid: chosen.info.pid,
            processName: chosen.info.name,
        };
    });
}
