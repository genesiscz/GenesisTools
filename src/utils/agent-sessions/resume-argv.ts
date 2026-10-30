import { harnessLaunch } from "@genesiscz/utils/ai/providers/harness-index";
import { escapeShellArg } from "@genesiscz/utils/string";
import type { AgentKind } from "./types";

export interface ResumeOptions {
    account?: string | null;
    home?: string;
    cwd?: string;
    model?: string;
}

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
    return harnessLaunch(kind).resumeArgv(sessionId, options);
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
