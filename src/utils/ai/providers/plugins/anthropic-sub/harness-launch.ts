import type { LaunchRecipe } from "@genesiscz/utils/harness/parts";

/** How a claude session resumes, and the flags a resume carries over, read from `claude --help` (claude 2.1, 2026-10-15). */
export const claudeLaunch: LaunchRecipe = {
    resumeArgv: (sessionId, options) =>
        options.account
            ? ["tools", "claude", "start", options.account, "--", "--resume", sessionId]
            : ["claude", "--resume", sessionId],
    resumeSyntax: { flags: ["--resume"], subcommand: false, render: (sessionId) => `--resume ${sessionId}` },

    resumeFlags: {
        "--add-dir": "value",
        "--agent": "value",
        "--agents": "value",
        "--allow-dangerously-skip-permissions": "none",
        "--allowedTools": "value",
        "--allowed-tools": "value",
        "--append-system-prompt": "value",
        "--autocompact": "value",
        "--bare": "none",
        "--betas": "value",
        "--brief": "none",
        "--chrome": "none",
        "--dangerously-skip-permissions": "none",
        "-d": "optional",
        "--debug": "optional",
        "--debug-file": "value",
        "--disable-slash-commands": "none",
        "--disallowedTools": "value",
        "--disallowed-tools": "value",
        "--effort": "value",
        "--ide": "none",
        "--mcp-config": "value",
        "--no-chrome": "none",
        "--permission-mode": "value",
        "--plugin-dir": "value",
        "--restricted": "none",
        "--safe-mode": "none",
        "--setting-sources": "value",
        "--settings": "value",
        "--strict-mcp-config": "none",
        "--system-prompt": "value",
        "--tools": "value",
    },
};
