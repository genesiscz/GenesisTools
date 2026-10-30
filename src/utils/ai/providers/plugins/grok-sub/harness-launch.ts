import type { LaunchRecipe } from "@genesiscz/utils/harness/parts";

/** How a grok session resumes, and the flags a resume carries over, read from `grok --help` (grok 1.x, 2026-10-15). */
export const grokLaunch: LaunchRecipe = {
    // `tools grok run <account>` sets the account's GROK_HOME; a bare `grok -r` resumes in the default home, where
    // another account's session does not exist.
    resumeArgv: (sessionId, options) =>
        options.account ? ["tools", "grok", "run", options.account, "--", "-r", sessionId] : ["grok", "-r", sessionId],
    resumeSyntax: { flags: ["-r", "--resume"], subcommand: false, render: (sessionId) => `-r ${sessionId}` },
    // The hub starts Grok in its default home and offers no account for it.
    startArgv: ({ prompt }) => ["grok", ...(prompt === undefined ? [] : [prompt])],
    startPinsAccount: false,
    // `tools grok cmux` has focus and send but no open-session: the hub types the resume argv into the pane.
    cmuxOpenSession: false,

    resumeFlags: {
        "--agent": "value",
        "--agents": "value",
        "--allow": "value",
        "--always-approve": "none",
        "--debug": "none",
        "--debug-file": "value",
        "--deny": "value",
        "--disable-web-search": "none",
        "--disallowed-tools": "value",
        "--fullscreen": "none",
        "--max-turns": "value",
        "--minimal": "none",
        "--no-alt-screen": "none",
        "--no-plan": "none",
        "--no-subagents": "none",
        "--permission-mode": "value",
        "--reasoning-effort": "value",
        "--rules": "value",
        "--sandbox": "value",
        "--tools": "value",
    },
};
