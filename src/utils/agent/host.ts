/**
 * Which agent host is running this process, and under what session id.
 *
 * Every host publishes its session id through the environment, and every child
 * it spawns inherits it. Four of them do it today, and each used to be read in
 * a different place with its own hardcoded key list — which is how grok ended up
 * with no identity at all until 2026-08-29, even though `GROK_SESSION_ID` had
 * been sitting in the environment the whole time. GitHub Copilot CLI repeated the
 * bug exactly, with `COPILOT_AGENT_SESSION_ID`, until 2026-08-31. Adding a host
 * is now one entry here plus one `runtime-context.ts`.
 *
 * This module is env-only on purpose. `getAgentRuntimeContext` adds git and
 * process-tree work on top; callers that only need "who am I" (the agents bus,
 * record-plan, todo defaults) must not pay for that.
 */

import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { resolveClaudeContext } from "@genesiscz/utils/agent/hosts/claude";
import { isCodex, resolveCodexContext } from "@genesiscz/utils/agent/hosts/codex";
import { isCopilot, resolveCopilotContext } from "@genesiscz/utils/agent/hosts/copilot";
import { isGrok, resolveGrokContext } from "@genesiscz/utils/agent/hosts/grok";

export type AgentHostKind = AgentRuntimeContext["agent"];

export interface AgentSessionId {
    agent: AgentHostKind;
    key: string;
    id: string;
}

/**
 * The session-id variable of each host, in precedence order.
 *
 * Order is precedence when hosts are nested: a worker inherits its parent's
 * variables (`src/grok/lib/worker.ts` and `src/codex/lib/spawn.ts` both spread
 * the parent environment), so the OUTER host wins. That is deliberate — it is
 * what keeps a spawned worker in its parent's swarm instead of inventing one.
 */
export const AGENT_SESSION_KEYS = [
    { agent: "claude-code", key: "CLAUDE_CODE_SESSION_ID" },
    { agent: "codex", key: "CODEX_THREAD_ID" },
    { agent: "grok", key: "GROK_SESSION_ID" },
    { agent: "copilot", key: "COPILOT_AGENT_SESSION_ID" },
] as const satisfies readonly { agent: AgentHostKind; key: string }[];

/**
 * Sessions assigned by whoever started this process, in order. `tools codex spawn`
 * and `tools grok run` write GT_RENDEZVOUS_SESSION into the worker environment;
 * GENESIS_AGENTS_SESSION is the user pinning a whole swarm by hand.
 *
 * These outrank every host id: a nested worker that preferred its own host id
 * would pin its children to a swarm its parent is not in (PR #343 review t29).
 */
export const ASSIGNED_SESSION_KEYS = ["GENESIS_AGENTS_SESSION", "GT_RENDEZVOUS_SESSION"] as const;

/** The swarm this process was told to join, or null if nobody said. */
export function assignedSessionId(env: NodeJS.ProcessEnv): string | null {
    for (const key of ASSIGNED_SESSION_KEYS) {
        const id = env[key]?.trim();
        if (id) {
            return id;
        }
    }

    return null;
}

/** The host chain. First match wins; see AGENT_SESSION_KEYS for why. */
export function resolveAgentHost(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext> {
    if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE) {
        return resolveClaudeContext(env);
    }

    if (isCodex(env)) {
        return resolveCodexContext(env);
    }

    if (isGrok(env)) {
        return resolveGrokContext(env);
    }

    if (isCopilot(env)) {
        return resolveCopilotContext(env);
    }

    return { agent: "unknown", sessionId: null, isInAgent: false };
}

/**
 * Every host session id present in the environment, in precedence order.
 *
 * For consumers that must CHOOSE among them rather than take the first —
 * the agents bus prefers the id whose swarm already exists, so that a worker
 * joins its parent instead of starting an orphan swarm.
 */
export function agentSessionIds(env: NodeJS.ProcessEnv): AgentSessionId[] {
    const found: AgentSessionId[] = [];

    for (const { agent, key } of AGENT_SESSION_KEYS) {
        const id = env[key]?.trim();
        if (id) {
            found.push({ agent, key, id });
        }
    }

    return found;
}
