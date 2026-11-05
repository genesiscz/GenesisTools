import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { copilotHost } from "@genesiscz/utils/agent/hosts/copilot";
import { harnessDriver, harnessDrivers } from "@genesiscz/utils/ai/providers/harness-index";
import type { HostResolver } from "@genesiscz/utils/harness/parts";
import { profiler } from "@genesiscz/utils/profile";
import type { CallerAgent, CallerReading, CallerSource } from "./types";

const prof = profiler.scope("agent-context");

/**
 * Every host whose environment can name a caller, in precedence order: the harnesses in the canonical driver order
 * (claude, codex, grok), then the hosts that are no harness (Copilot). Order is precedence when hosts are nested: a
 * worker inherits its parent's variables, so the OUTER host wins, which keeps a spawned worker in its parent's swarm.
 */
export function envHosts(): readonly HostResolver[] {
    return [...harnessDrivers().map((driver) => harnessDriver(driver.id).parts.host), copilotHost];
}

/** The host part that reports this runtime agent, or undefined for `unknown`. */
export function hostOf(agent: CallerAgent): HostResolver | undefined {
    return envHosts().find((host) => host.agent === agent);
}

/** A trimmed env value, or undefined when it is unset or blank (an unset variable a shell command expanded). */
export function envValue(env: NodeJS.ProcessEnv, key: string | null): string | undefined {
    const value = key ? env[key]?.trim() : undefined;
    return value ? value : undefined;
}

/** The host chain over one environment: the first host that detects itself answers. */
export function resolveEnvHost(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext> {
    return prof.measure("host.resolveAgentHost", () => {
        for (const host of envHosts()) {
            if (host.detects(env)) {
                return host.resolve(env);
            }
        }

        return { agent: "unknown", sessionId: null, isInAgent: false };
    });
}

/** The label of a host that takes one (`AI_AGENT` for Claude, Grok, Copilot and a plain shell; never Codex), trimmed. */
export function hostLabel(agent: CallerAgent, env: NodeJS.ProcessEnv): string | null {
    const key = agent === "unknown" ? "AI_AGENT" : (hostOf(agent)?.labelEnvKey ?? null);
    return envValue(env, key) ?? null;
}

/**
 * The environment of a local caller. Its host names the agent and session; the same host's own variables add the
 * tool call (Codex `CODEX_TOOL_CALL_ID`), the effort (Claude `CLAUDE_EFFORT`) and, where the host names a root
 * session beside the thread (Codex `CODEX_SESSION_ID`), the subagent: a thread that is not the root is a subagent's,
 * so the thread is both the session and the subagent id. With no host the label is the untrimmed `AI_AGENT`, as the
 * runtime context has always kept it.
 */
export const envSource: CallerSource = {
    id: "env",
    read: (input) => {
        if (input.origin !== "local") {
            return undefined;
        }

        const env = input.env;
        const resolved = resolveEnvHost(env);
        const agent = resolved.agent ?? "unknown";
        const host = hostOf(agent);
        const reading: CallerReading = {
            agent,
            sessionId: resolved.sessionId ?? null,
            isInAgent: resolved.isInAgent ?? false,
            aiAgent: "aiAgent" in resolved ? (resolved.aiAgent ?? null) : (env.AI_AGENT ?? null),
        };
        const toolUseId = host ? envValue(env, host.toolUseEnvKey) : undefined;
        const effort = host ? envValue(env, host.effortEnvKey) : undefined;

        if (toolUseId) {
            reading.toolUseId = toolUseId;
        }

        if (effort) {
            reading.effort = effort;
        }

        const root = host ? envValue(env, host.rootSessionEnvKey) : undefined;

        if (root && reading.sessionId && root !== reading.sessionId) {
            reading.subagentId = reading.sessionId;
        }

        return reading;
    },
};
