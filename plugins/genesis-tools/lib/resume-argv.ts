import type { Harness } from "../hooks/harness";

/**
 * The command that resumes a session in a terminal, as `resumeArgv` in src/utils/agent-sessions/resume-argv.ts
 * builds it for an account (a plugin file cannot import that module). resume-argv.test.ts holds the two equal.
 */
export function resumeArgv(harness: Harness, sessionId: string, account?: string | null): string[] {
    if (harness === "grok") {
        return ["grok", "-r", sessionId];
    }

    if (harness === "codex") {
        return account ? ["tools", "codex", "run", account, "--", "resume", sessionId] : ["codex", "resume", sessionId];
    }

    return account
        ? ["tools", "claude", "start", account, "--", "--resume", sessionId]
        : ["claude", "--resume", sessionId];
}
