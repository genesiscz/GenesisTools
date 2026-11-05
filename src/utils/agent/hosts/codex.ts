import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";

/**
 * Codex runtime detection. Research-confirmed (openai/codex):
 *  - CODEX_CI === "1" is set on every Codex-spawned shell command (the marker).
 *  - CODEX_THREAD_ID is the conversation/thread id (≈ Claude's session id).
 * There is no CLAUDECODE-style separate flag; CODEX_CI IS the detector.
 *
 * A whitespace-only thread id is what an unset variable expands to in a shell command, so it names no thread and
 * does not make the process a Codex host.
 */
function codexThreadId(env: NodeJS.ProcessEnv): string | null {
    const id = env.CODEX_THREAD_ID?.trim();
    return id ? id : null;
}

export function isCodex(env: NodeJS.ProcessEnv): boolean {
    return env.CODEX_CI === "1" || codexThreadId(env) !== null;
}

export function resolveCodexContext(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext> {
    return {
        agent: "codex",
        sessionId: codexThreadId(env),
        isInAgent: isCodex(env),
        aiAgent: null,
    };
}
