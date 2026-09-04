import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";

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
