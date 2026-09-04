import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";

/**
 * Grok CLI runtime detection.
 *
 * `GROK_SESSION_ID` is a uuid grok sets in the environment of every process it
 * spawns, its MCP servers included. It was there all along and nothing read it,
 * so every grok-authored Q&A and handoff event landed as agent "unknown" with a
 * null session id. A null id cannot claim a handoff (src/handoff/fold.ts), which
 * is what blocked grok from working one on 2026-08-29.
 */
function grokSessionId(env: NodeJS.ProcessEnv): string | null {
    // A whitespace-only value is what an unset variable expands to in a shell
    // command. Treating it as a session marks the process as an agent and then
    // hands downstream routing an id that identifies nothing.
    const id = env.GROK_SESSION_ID?.trim();
    return id ? id : null;
}

export function isGrok(env: NodeJS.ProcessEnv): boolean {
    return grokSessionId(env) !== null;
}

export function resolveGrokContext(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext> {
    return {
        agent: "grok",
        sessionId: grokSessionId(env),
        isInAgent: true,
        aiAgent: env.AI_AGENT ?? null,
    };
}
