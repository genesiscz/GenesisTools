import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";

export function isClaude(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE);
}

export function resolveClaudeContext(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext> {
    return {
        agent: "claude-code",
        sessionId: env.CLAUDE_CODE_SESSION_ID ?? null,
        isInAgent: !!env.CLAUDECODE,
        aiAgent: env.AI_AGENT ?? null,
    };
}
