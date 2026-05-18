import type { AgentRuntimeContext } from "@app/utils/claude/runtime-context";

/**
 * Codex runtime detection. Research-confirmed (openai/codex):
 *  - CODEX_CI === "1" is set on every Codex-spawned shell command (the marker).
 *  - CODEX_THREAD_ID is the conversation/thread id (≈ Claude's session id).
 * There is no CLAUDECODE-style separate flag; CODEX_CI IS the detector.
 */
export function isCodex(env: NodeJS.ProcessEnv): boolean {
    return env.CODEX_CI === "1" || !!env.CODEX_THREAD_ID;
}

export function resolveCodexContext(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext> {
    return {
        agent: "codex",
        sessionId: env.CODEX_THREAD_ID ?? null,
        isInAgent: env.CODEX_CI === "1" || !!env.CODEX_THREAD_ID,
        aiAgent: null,
    };
}
