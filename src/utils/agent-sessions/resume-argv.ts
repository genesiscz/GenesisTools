import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { escapeShellArg } from "@genesiscz/utils/string";
import type { AgentKind } from "./types";

export interface ResumeOptions {
    account?: string | null;
    home?: string;
    cwd?: string;
    model?: string;
}

/**
 * One recipe per coding agent. Exhaustive on purpose: a fourth agent fails to compile here
 * instead of silently falling through to another agent's binary.
 */
const RESUME_RECIPES: Record<AccountProviderAlias, (sessionId: string, options: ResumeOptions) => string[]> = {
    grok: (sessionId) => ["grok", "-r", sessionId],
    codex: (sessionId, options) => {
        if (!options.account) {
            return ["codex", "resume", sessionId];
        }
        return [
            "tools",
            "codex",
            "run",
            options.account,
            ...(options.home ? ["--home", options.home] : []),
            ...(options.cwd ? ["--cwd", options.cwd] : []),
            ...(options.model ? ["--model", options.model] : []),
            "--",
            "resume",
            sessionId,
        ];
    },
    claude: (sessionId, options) =>
        options.account
            ? ["tools", "claude", "start", options.account, "--", "--resume", sessionId]
            : ["claude", "--resume", sessionId],
};

/**
 * Argv that resumes an interactive TUI session. Shared by cmux replay,
 * `tools grok run --resume`, and restore-after-restart.
 */
export function resumeArgv(
    kind: AgentKind,
    sessionId: string,
    accountOrOptions?: string | null | ResumeOptions
): string[] {
    const options =
        typeof accountOrOptions === "object" && accountOrOptions !== null
            ? accountOrOptions
            : { account: accountOrOptions };
    return RESUME_RECIPES[kind](sessionId, options);
}

export function resumeCommandLine(
    kind: AgentKind,
    sessionId: string,
    accountOrOptions?: string | null | ResumeOptions
): string {
    return resumeArgv(kind, sessionId, accountOrOptions)
        .map((token) => (/^[A-Za-z0-9_./:@=-]+$/.test(token) ? token : escapeShellArg(token)))
        .join(" ");
}
