import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";

/**
 * A whitespace-only value is what an unset variable expands to in a shell command. Taking it as a session made the
 * process a Claude host and hid a valid lower host (a Codex thread) behind an id that identifies nothing.
 */
function claudeSessionId(env: NodeJS.ProcessEnv): string | null {
    const id = env.CLAUDE_CODE_SESSION_ID?.trim();
    return id ? id : null;
}

export function isClaude(env: NodeJS.ProcessEnv): boolean {
    return Boolean(claudeSessionId(env) || env.CLAUDECODE);
}

export function resolveClaudeContext(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext> {
    return {
        agent: "claude-code",
        sessionId: claudeSessionId(env),
        isInAgent: !!env.CLAUDECODE,
        aiAgent: env.AI_AGENT ?? null,
    };
}
