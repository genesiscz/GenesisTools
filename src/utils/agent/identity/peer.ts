import { harnessDriver, harnessOfRuntimeAgent } from "@genesiscz/utils/ai/providers/harness-index";
import type { PeerSessionPart } from "@genesiscz/utils/harness/parts";
import { logger } from "@genesiscz/utils/logger";
import { runtimeAgentOfCommand } from "@genesiscz/utils/process/classify";
import { readProcessCwd } from "@genesiscz/utils/process/cwd";
import { findLoopbackClientPids, type ProcessInfo, readProcessInfo } from "@genesiscz/utils/process/socket-owner";
import { profiler } from "@genesiscz/utils/profile";
import { envHosts } from "./env";
import type { CallerAgent, PeerQuery, ScopedCaller } from "./types";

const { log } = logger.scoped("agent-context");
const prof = profiler.scope("agent-context");

/** A remote MCP caller as the gateway sees it: the process that holds the client end of the connection. */
export interface PeerCaller extends ScopedCaller {
    pid: number | null;
    processName: string | null;
}

/** The host chain's order (outer host first), used to pick among several host processes on one socket. */
function precedence(agent: CallerAgent): number {
    return envHosts().findIndex((host) => host.agent === agent);
}

/**
 * How a calling process of this runtime agent names its session, from its harness driver's `peer` part (Claude by its
 * session registry, Codex by the one rollout it holds open). Copilot and an unknown process have no harness, so none.
 */
function peerPartOf(agent: CallerAgent): PeerSessionPart | null {
    const harness = harnessOfRuntimeAgent(agent);
    return harness ? harnessDriver(harness).parts.peer : null;
}

function peerSessionOf(info: ProcessInfo, agent: CallerAgent, query: PeerQuery): string | null {
    const harness = harnessOfRuntimeAgent(agent);
    const part = peerPartOf(agent);

    if (!harness || !part?.supported) {
        return null;
    }

    return part.sessionOf(info, query.registryDirOf?.(harness));
}

/** Whether the gateway can name the session of a calling process of this runtime agent, so its MCP client may use HTTP. */
export function callerSessionReadable(agent: CallerAgent): boolean {
    return peerPartOf(agent)?.supported === true;
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
            precedence(a.agent) - precedence(b.agent) ||
            a.info.pid - b.info.pid
    )[0];
}

/** The host process that holds the client end of this connection, and what it is running. */
export function readPeerCaller(query: PeerQuery): PeerCaller {
    return prof.measure("gateway.resolveCallerFromPeer", () => {
        const pids = findLoopbackClientPids({ clientPort: query.clientPort, serverPort: query.serverPort });
        const infos = pids.map(readProcessInfo).filter((info): info is ProcessInfo => info !== null);
        const hosts: Candidate[] = infos.flatMap((info) => {
            const agent = runtimeAgentOfCommand(info.name);
            return agent ? [{ info, agent, sessionId: peerSessionOf(info, agent, query) }] : [];
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
