import type { AgentKind } from "./types";

/**
 * Argv that resumes an interactive TUI session. Shared by cmux replay,
 * `tools grok run --resume`, and restore-after-restart.
 */
export function resumeArgv(kind: AgentKind, sessionId: string, account?: string | null): string[] {
    if (kind === "grok") {
        return ["grok", "-r", sessionId];
    }

    if (kind === "codex") {
        return ["codex", "resume", sessionId];
    }

    if (account) {
        return ["tools", "claude", "start", account, "--", "--resume", sessionId];
    }

    return ["claude", "--resume", sessionId];
}

export function resumeCommandLine(kind: AgentKind, sessionId: string, account?: string | null): string {
    return resumeArgv(kind, sessionId, account)
        .map((token) => (/\s/.test(token) ? `'${token.replace(/'/g, `'\\''`)}'` : token))
        .join(" ");
}
