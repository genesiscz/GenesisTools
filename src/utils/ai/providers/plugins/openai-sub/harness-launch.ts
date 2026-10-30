import type { LaunchRecipe } from "@genesiscz/utils/harness/parts";

/** How a codex session resumes, and the flags a resume carries over, read from `codex resume --help` (codex 0.13x, 2026-10-15). */
export const codexLaunch: LaunchRecipe = {
    resumeArgv: (sessionId, options) => {
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
    resumeFlags: {
        "-a": "value",
        "--add-dir": "value",
        "--approve-for-me": "none",
        "--ask-for-approval": "value",
        "-c": "value",
        "--config": "value",
        "--dangerously-bypass-approvals-and-sandbox": "none",
        "--dangerously-bypass-hook-trust": "none",
        "--disable": "value",
        "--enable": "value",
        "--local-provider": "value",
        "--no-alt-screen": "none",
        "--no-daemon": "none",
        "--oss": "none",
        "-p": "value",
        "--profile": "value",
        "-s": "value",
        "--sandbox": "value",
        "--search": "none",
        "--strict-config": "none",
    },
};
