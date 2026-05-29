export interface AgentRuntimeContext {
    agent: "claude-code" | "codex" | "unknown";
    sessionId: string | null;
    isInAgent: boolean;
    aiAgent: string | null;
    sessionTitle: string | null;
    project: string;
    repoRoot: string;
    cwd: string;
    isWorktree: boolean;
    worktreePath: string | null;
    branch: string | null;
    commitSha: string | null;
    commitMessage: string | null;
}

export function resolveClaudeContext(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext> {
    return {
        agent: "claude-code",
        sessionId: env.CLAUDE_CODE_SESSION_ID ?? null,
        isInAgent: !!env.CLAUDECODE,
        aiAgent: env.AI_AGENT ?? null,
    };
}
