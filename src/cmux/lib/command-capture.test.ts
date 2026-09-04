import { describe, expect, test } from "bun:test";
import {
    agentKindFromLauncher,
    cleanLaunchCommand,
    deriveReplayCommand,
    isAgentLauncher,
} from "@app/cmux/lib/command-capture";

describe("cleanLaunchCommand", () => {
    test("strips the bun wrapper down to `tools`", () => {
        expect(cleanLaunchCommand("bun /Users/x/Projects/GenesisTools/tools cc run a --resume burn")).toBe(
            "tools cc run a --resume burn"
        );
        expect(cleanLaunchCommand("/Users/x/.bun/bin/bun run /repo/tools cc run a")).toBe("tools cc run a");
    });

    test("normalizes an absolute grok path", () => {
        expect(cleanLaunchCommand("/Users/x/.local/bin/grok --resume")).toBe("grok --resume");
    });

    test("leaves ordinary commands alone", () => {
        expect(cleanLaunchCommand("vim notes.md")).toBe("vim notes.md");
    });
});

describe("deriveReplayCommand", () => {
    const sessionId = "aa45fee8-9a3b-4745-83d2-89a4445092b7";

    test("vim and other non-agent commands pass through with no drift", () => {
        // Regression test: 2026-09-02 — grok used to be in this bucket, so restore
        // typed `grok` (or nothing) instead of `grok -r <session>`.
        const result = deriveReplayCommand({ original: "vim notes.md", sessionId, account: "work" });
        expect(result.command).toBe("vim notes.md");
        expect(result.drift).toEqual([]);
    });

    test("bare grok gets -r <session> so restore resumes the same conversation", () => {
        const result = deriveReplayCommand({ original: "grok", sessionId });
        expect(result.command).toBe(`grok -r ${sessionId}`);
        expect(result.drift.some((d) => d.includes(sessionId))).toBe(true);
    });

    test("grok --resume without an id is pinned to the session that ran here", () => {
        const result = deriveReplayCommand({ original: "grok --resume", sessionId });
        expect(result.command).toBe(`grok --resume ${sessionId}`);
    });

    test("grok -r with the wrong id is replaced", () => {
        const result = deriveReplayCommand({ original: "grok -r old-session", sessionId });
        expect(result.command).toBe(`grok -r ${sessionId}`);
        expect(result.drift.some((d) => d.includes("old-session"))).toBe(true);
    });

    test("grok already resuming the right session passes through with no drift", () => {
        const result = deriveReplayCommand({ original: `grok -r ${sessionId}`, sessionId });
        expect(result.command).toBe(`grok -r ${sessionId}`);
        expect(result.drift).toEqual([]);
    });

    test("without a session id the original is kept verbatim", () => {
        const result = deriveReplayCommand({ original: "tools cc run work --resume burn" });
        expect(result.command).toBe("tools cc run work --resume burn");
        expect(result.drift).toEqual([]);
    });

    test("adds the pinned account and flags the drift when the original had none", () => {
        const result = deriveReplayCommand({ original: "tools cc run", sessionId, account: "work" });
        expect(result.command).toBe(`tools cc run work -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes('account "work" added'))).toBe(true);
    });

    test("keeps the original explicit account over the pinned one", () => {
        const result = deriveReplayCommand({
            original: "tools cc run personal --resume burn",
            sessionId,
            account: "work",
        });
        expect(result.command).toBe(`tools cc run personal -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes('resume target "burn" replaced'))).toBe(true);
        expect(result.drift.some((d) => d.includes("account"))).toBe(false);
    });

    test("`tools claude run` keeps its explicit account and its own launcher spelling", () => {
        // The launcher test accepted both spellings while the account parser only
        // matched `tools cc run`, so `tools claude run personal` silently replayed
        // under the journal account and the drift line claimed there had been none.
        const result = deriveReplayCommand({
            original: "tools claude run personal --resume burn",
            sessionId,
            account: "work",
        });
        expect(result.command).toBe(`tools claude run personal -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes("account"))).toBe(false);
    });

    test("every other flag the user typed survives the replay", () => {
        // `tools cc run work --model opus --verbose` used to restore as
        // `tools cc run work -- --resume <id>`: the model and the verbosity were
        // gone, and the only drift note said the command had been "rewritten".
        const result = deriveReplayCommand({
            original: "tools cc run work --model opus --verbose",
            sessionId,
            account: "work",
        });

        expect(result.command).toBe(`tools cc run work --model opus --verbose -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes("rewritten"))).toBe(false);
    });

    test("an existing passthrough tail is kept and the resume joins it", () => {
        const result = deriveReplayCommand({
            original: "tools cc run work -- --dangerously-skip-permissions",
            sessionId,
            account: "work",
        });

        expect(result.command).toBe(`tools cc run work -- --dangerously-skip-permissions --resume ${sessionId}`);
    });

    test("a resume already after -- is pinned in place, and the right one is left alone", () => {
        expect(
            deriveReplayCommand({
                original: "tools cc run work --model opus -- --resume burn",
                sessionId,
                account: "work",
            }).command
        ).toBe(`tools cc run work --model opus -- --resume ${sessionId}`);

        const unchanged = deriveReplayCommand({
            original: `tools cc run work --model opus -- --resume ${sessionId}`,
            sessionId,
            account: "work",
        });
        expect(unchanged.command).toBe(`tools cc run work --model opus -- --resume ${sessionId}`);
        expect(unchanged.drift).toEqual([]);
    });

    test("the pinned account is spliced in without losing the flags around it", () => {
        const result = deriveReplayCommand({
            original: "tools cc run --model opus",
            sessionId,
            account: "work",
        });

        expect(result.command).toBe(`tools cc run work --model opus -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes('account "work" added'))).toBe(true);
    });

    test("flags a bare --resume picker being replaced", () => {
        const result = deriveReplayCommand({ original: "tools cc run work --resume", sessionId, account: "work" });
        expect(result.command).toBe(`tools cc run work -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes("bare --resume"))).toBe(true);
    });

    test("bare claude launchers keep the launcher and other flags, only pinning the resume target", () => {
        const result = deriveReplayCommand({
            original: "claude --model opus --resume burn",
            sessionId,
            account: "work",
        });
        expect(result.command).toBe(`claude --model opus --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes('resume target "burn" replaced'))).toBe(true);
    });

    test("bare claude without --resume gets one appended", () => {
        const result = deriveReplayCommand({ original: "claude --model opus", sessionId });
        expect(result.command).toBe(`claude --model opus --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes("added"))).toBe(true);
    });

    test("bare claude already resuming the right session passes through with no drift", () => {
        const result = deriveReplayCommand({ original: `claude --resume ${sessionId}`, sessionId });
        expect(result.command).toBe(`claude --resume ${sessionId}`);
        expect(result.drift).toEqual([]);
    });

    test("without any account the command defers to cc run's own prompt and says so", () => {
        const result = deriveReplayCommand({ original: "tools cc run", sessionId });
        expect(result.command).toBe(`tools cc run -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes("no account recorded"))).toBe(true);
    });

    test("a -r inside a quoted prompt is left alone, not rewritten mid-string", () => {
        // The regex matched the flag anywhere after whitespace, so restore typed
        // `grok -p "explain the -r <uuid>` — an unterminated quote — into the pane.
        const result = deriveReplayCommand({ original: 'grok -p "explain the -r flag"', sessionId });
        expect(result.command).toBe(`grok -p "explain the -r flag" -r ${sessionId}`);
        expect(result.drift.some((d) => d.includes("added"))).toBe(true);
    });

    test("a --resume mentioned inside a quoted prompt does not count as a resume target", () => {
        const result = deriveReplayCommand({ original: 'grok --model x -p "use -r or --resume"', sessionId });
        expect(result.command).toBe(`grok --model x -p "use -r or --resume" -r ${sessionId}`);
    });

    test("a claude prompt quoting --resume still gets its own flag appended", () => {
        const result = deriveReplayCommand({ original: 'claude -p "what does --resume do"', sessionId });
        expect(result.command).toBe(`claude -p "what does --resume do" --resume ${sessionId}`);
    });
});

describe("isAgentLauncher", () => {
    test("recognises the `tools claude start` form this module's own replay emits", () => {
        // While it did not, a saved `tools claude start … --resume <old>` was
        // returned verbatim forever: never re-pinned, never discarded.
        expect(isAgentLauncher("tools claude start work -- --resume abc")).toBe(true);
        expect(isAgentLauncher("tools cc start work")).toBe(true);
    });

    test("still refuses a launcher that is only mentioned inside another command", () => {
        expect(isAgentLauncher("echo tools claude start")).toBe(false);
    });

    test("recognises grok and codex launchers", () => {
        expect(isAgentLauncher("grok -r abc")).toBe(true);
        expect(isAgentLauncher("codex resume abc")).toBe(true);
        expect(isAgentLauncher("echo grok")).toBe(false);
    });
});

describe("deriveReplayCommand on a `tools claude start` original", () => {
    const sessionId = "aa45fee8-9a3b-4745-83d2-89a4445092b7";

    test("re-pins the resume target and keeps the launcher and account", () => {
        const result = deriveReplayCommand({
            original: "tools claude start 'work' -- --resume 'OLD'",
            sessionId,
            account: "work",
        });
        expect(result.command).toBe(`tools claude start 'work' -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes("replaced"))).toBe(true);
    });
});

describe("deriveReplayCommand for codex", () => {
    const sessionId = "01a067d4-d2b0-7532-8f59-9af2a29c2d0e";

    test("rewrites a bare codex capture to codex resume <id>", () => {
        const result = deriveReplayCommand({ original: "codex", sessionId });
        expect(result.command).toBe(`codex resume ${sessionId}`);
    });

    test("keeps every flag and splices the resume subcommand in", () => {
        // The whole command used to be discarded: model, cwd and sandbox mode
        // all vanished from the restored pane.
        const result = deriveReplayCommand({ original: "codex --model gpt-5.6 --cd /repo --full-auto", sessionId });
        expect(result.command).toBe(`codex resume ${sessionId} --model gpt-5.6 --cd /repo --full-auto`);
    });

    test("re-pins an existing resume target in place", () => {
        const result = deriveReplayCommand({ original: "codex resume OLD --model gpt-5.6", sessionId });
        expect(result.command).toBe(`codex resume ${sessionId} --model gpt-5.6`);
        expect(result.drift.some((entry) => entry.includes("replaced"))).toBe(true);
    });

    test("fills a bare resume that would open the picker", () => {
        const result = deriveReplayCommand({ original: "codex resume --model gpt-5.6", sessionId });
        expect(result.command).toBe(`codex resume ${sessionId} --model gpt-5.6`);
    });

    test("leaves an already-pinned command untouched", () => {
        const result = deriveReplayCommand({ original: `codex resume ${sessionId}`, sessionId });
        expect(result.command).toBe(`codex resume ${sessionId}`);
        expect(result.drift).toEqual([]);
    });
});

describe("agent launchers do not match a hyphenated neighbour", () => {
    test("codex-gateway is not codex", () => {
        // `\b` sits between "x" and "-", so `codex-gateway serve` was treated as
        // a codex launcher and rewritten to `codex resume <uuid>` on restore.
        expect(isAgentLauncher("codex-gateway serve")).toBe(false);
        expect(agentKindFromLauncher("codex-gateway serve")).toBeUndefined();
    });

    test("grok-proxy is not grok", () => {
        expect(isAgentLauncher("grok-proxy up")).toBe(false);
    });

    test("claude-monitor is not claude", () => {
        expect(isAgentLauncher("claude-monitor --watch")).toBe(false);
    });

    test("the real launchers still match", () => {
        expect(agentKindFromLauncher("codex resume abc")).toBe("codex");
        expect(agentKindFromLauncher("grok -r abc")).toBe("grok");
        expect(agentKindFromLauncher("claude --resume abc")).toBe("claude");
    });
});

describe("etimeToSeconds", () => {
    test("parses mm:ss, hh:mm:ss and dd-hh:mm:ss", async () => {
        const { etimeToSeconds } = await import("@app/cmux/lib/command-capture");
        expect(etimeToSeconds("00:05")).toBe(5);
        expect(etimeToSeconds("01:02:03")).toBe(3723);
        expect(etimeToSeconds("2-01:00:00")).toBe(176400);
        expect(etimeToSeconds("garbage")).toBe(0);
    });
});
