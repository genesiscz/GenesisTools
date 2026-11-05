import { copilotHost } from "@genesiscz/utils/agent/hosts/copilot";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import { envSource } from "./env";
import { readPeerCaller } from "./peer";
import type { CallerReading, CallerSource } from "./types";

/** The hook payload of a local caller: it names the harness that ran the hook, read from the payload, not the env. */
export const hookPayloadSource: CallerSource = {
    id: "hook-payload",
    read: (input) => {
        if (input.origin !== "local" || !input.hook) {
            return undefined;
        }

        const { caller, sessionId, toolUseId, subagentId, turnId, model, transcriptPath, cwd } = input.hook;
        const agent = caller === "copilot" ? copilotHost.agent : harnessDriver(caller).parts.host.agent;
        const reading: CallerReading = { agent, isInAgent: true };
        const facts = { sessionId, toolUseId, subagentId, turnId, model, transcriptPath, cwd };

        for (const [field, value] of Object.entries(facts)) {
            if (value) {
                Object.assign(reading, { [field]: value });
            }
        }

        return reading;
    },
};

/** The caller a resident server's request scope holds (`runAsCaller`); it replaces the env host completely. */
export const callerScopeSource: CallerSource = {
    id: "caller-scope",
    read: (input) => {
        if (input.origin !== "remote" || !input.caller) {
            return undefined;
        }

        const { agent, sessionId, cwd, sourceMessage } = input.caller;
        const reading: CallerReading = { agent, sessionId, isInAgent: agent !== "unknown", aiAgent: null };

        if (cwd !== null) {
            reading.cwd = cwd;
        }

        if (sourceMessage) {
            reading.sourceMessage = sourceMessage;
        }

        return reading;
    },
};

/** A remote MCP caller's connection, resolved to the host process that holds it (`lsof` and the process table). */
export const mcpPeerSource: CallerSource = {
    id: "mcp-peer",
    read: (input) => {
        if (input.origin !== "remote" || !input.peer) {
            return undefined;
        }

        const peer = readPeerCaller(input.peer);
        const reading: CallerReading = {
            agent: peer.agent,
            sessionId: peer.sessionId,
            isInAgent: peer.agent !== "unknown",
            aiAgent: null,
        };

        if (peer.cwd !== null) {
            reading.cwd = peer.cwd;
        }

        if (peer.pid !== null) {
            reading.process = { pid: peer.pid, ancestry: [] };
        }

        return reading;
    },
};

/**
 * THE precedence rule, written once. A hook payload names the caller when there is one (a Codex worker spawned from
 * Claude inherits every CLAUDE_CODE_* variable, so the payload outranks the env); a resident server's request scope,
 * then the connection's owner, name a remote caller; the environment's host chain names a local one, outer host first.
 * The first source that names an agent chooses the caller; a later source adds facts only for the same agent and
 * session.
 */
export const CALLER_SOURCES: readonly CallerSource[] = [hookPayloadSource, callerScopeSource, mcpPeerSource, envSource];
