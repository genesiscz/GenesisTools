import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import type { HostResolver } from "@genesiscz/utils/harness/parts";

/**
 * GitHub Copilot CLI runtime detection.
 *
 * `COPILOT_AGENT_SESSION_ID` is the uuid Copilot CLI puts in the environment of
 * every process it spawns, its MCP servers included — it mirrors the CLI's own
 * `--session-id` argv. Verified live on 2026-08-31 against copilot 1.0.82: the
 * `tools claude mcp` child carried the same uuid the parent was started with,
 * and the name appears in copilot's own `app.js` and `sdk/index.js` from 1.0.77
 * through 1.0.82.
 *
 * This is the same shape of bug grok had until 2026-08-29: the variable was
 * there all along and nothing read it, so every Copilot-authored Q&A and handoff
 * event landed as agent "unknown" with a null session id. A null id cannot claim
 * a handoff (src/handoff/fold.ts), which is what blocked Copilot on 2026-08-31.
 */
function copilotSessionId(env: NodeJS.ProcessEnv): string | null {
    // A whitespace-only value is what an unset variable expands to in a shell
    // command. Treating it as a session marks the process as an agent and then
    // hands downstream routing an id that identifies nothing.
    const id = env.COPILOT_AGENT_SESSION_ID?.trim();
    return id ? id : null;
}

export function isCopilot(env: NodeJS.ProcessEnv): boolean {
    return copilotSessionId(env) !== null;
}

export function resolveCopilotContext(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext> {
    return {
        agent: "copilot",
        sessionId: copilotSessionId(env),
        isInAgent: true,
        aiAgent: env.AI_AGENT ?? null,
    };
}

/**
 * What a hook payload of a host that is no harness carries, as data for `src/agents/lib/hooks/payload.ts`, the one
 * reader of payload fields.
 */
export interface HostPayloadMarkers {
    /** Fields only this host's payloads carry; any one of them names the host. */
    readonly markerFields: readonly string[];
    /** It names its events in lower camelCase (`subagentStop`), which no harness of ours does. */
    readonly lowerCamelEvents: boolean;
    /** Its camelCase payloads carry `timestamp` as epoch milliseconds, a number, where Grok writes a string. */
    readonly numericTimestamp: boolean;
    /** The fields that name the subagent that made the call, in both spellings. */
    readonly subagentIdFields: readonly string[];
}

/** The facts of a host that is not one of our harnesses: the harness drivers' host part, plus what a hook or a peer sees. */
export interface NonHarnessHost extends HostResolver {
    /** The executable name a calling process of this host has (the MCP gateway's peer lookup). */
    readonly binary: string;
    readonly payload: HostPayloadMarkers;
}

/**
 * GitHub Copilot CLI as a host. It is no harness of GenesisTools: no account stamp (`accountEnvVar` has no alias for
 * it), and no transcript location, model or command-level tool call id was established (research note 2026-11-04),
 * so the identity module leaves those facts empty rather than guess.
 */
export const copilotHost: NonHarnessHost = {
    agent: "copilot",
    binary: "copilot",
    sessionEnvKey: "COPILOT_AGENT_SESSION_ID",
    pidEnvKey: null,
    toolUseEnvKey: null,
    labelEnvKey: "AI_AGENT",
    effortEnvKey: null,
    detects: isCopilot,
    resolve: resolveCopilotContext,
    payload: {
        // docs.github.com/en/copilot/reference/hooks-reference: subagent hooks add the parent agent id.
        markerFields: ["parentAgentId", "parent_agent_id"],
        lowerCamelEvents: true,
        numericTimestamp: true,
        subagentIdFields: ["agentId", "agent_id"],
    },
};
