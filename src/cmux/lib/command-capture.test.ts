import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentKindFromLauncher,
    claudeSessionFromArgv,
    cleanLaunchCommand,
    collectTtyCapture,
    deriveReplayCommand,
    discoverCcRunAliases,
    isAgentLauncher,
    journalReplayCommand,
    loadSurfaceSessions,
    resumeQueryFromCommand,
    resumeTargetFromCommand,
    setCcRunAliases,
    stripModelFlags,
} from "@app/cmux/lib/command-capture";
import { SafeJSON } from "@genesiscz/utils/json";
import * as processes from "@genesiscz/utils/process/processes";

beforeAll(() => {
    setCcRunAliases(["cr"]);
});

afterAll(() => {
    setCcRunAliases(undefined);
});

describe("collectTtyCapture", () => {
    test("the launcher started a few ms before its agent in the same second is the launch command", async () => {
        const base = 1_792_001_371_000;
        const entry = (pid: number, startMs: number) => ({
            pid,
            ppid: 1,
            pgid: null,
            uid: null,
            name: "x",
            command: null,
            tty: "ttys007",
            startMs,
            zombie: false,
            state: "S",
        });
        const commands: Record<number, string> = {
            4199: "bun /Users/x/Projects/GenesisTools/tools claude run work",
            4207: "gt-cc run work",
            4208: "/Users/x/.bun/bin/claude --resume 3f6c2a1e-1111-4222-8333-944455556666",
        };
        // The kernel table lists the newest pid first.
        const list = spyOn(processes, "listProcesses").mockReturnValue([
            entry(4208, base + 579),
            entry(4207, base + 559),
            entry(4199, base + 471),
        ]);
        const read = spyOn(processes, "readProcess").mockImplementation((pid) => ({
            ...entry(pid, base),
            command: commands[pid] ?? null,
        }));

        try {
            const capture = await collectTtyCapture();
            expect(capture.launchCommands.get("ttys007")).toBe("tools claude run work");
        } finally {
            list.mockRestore();
            read.mockRestore();
        }
    });
});

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

test("compound agent commands remain verbatim when a session is known", () => {
    for (const original of [
        "claude --model custom; printf done",
        "grok && printf done",
        "codex | cat",
        "claude\nprintf done",
        "claude > output.log",
    ]) {
        expect(deriveReplayCommand({ original, sessionId: "fixture-session" }).command).toBe(original);
    }
});
describe("a shell alias that execs `tools cc run` is a cc run launcher", () => {
    // 2026-09-08: every Claude pane was started as `cr work`. The launcher
    // regex did not know `cr`, so the pane replayed `cr work` verbatim and
    // opened a NEW session while the surface journal knew the id all along.
    const sessionId = "931c9dee-1ced-43da-bf10-40e0b048320c";

    test("is recognised and typed as claude", () => {
        expect(isAgentLauncher("cr work")).toBe(true);
        expect(agentKindFromLauncher("cr work")).toBe("claude");
        expect(isAgentLauncher("crontab -l")).toBe(false);
        expect(agentKindFromLauncher("cr-tool")).toBeUndefined();
    });

    test("gets the pane's session appended after --", () => {
        const result = deriveReplayCommand({ original: "cr work", sessionId });
        expect(result.command).toBe(`cr work -- --resume ${sessionId}`);
        expect(result.drift).toEqual([`-- --resume ${sessionId} added (session that was active in this pane)`]);
    });

    test("drops a fuzzy cc-run --resume query and pins the concrete id after --", () => {
        const result = deriveReplayCommand({ original: "cr work --resume 234567", sessionId });
        expect(result.command).toBe(`cr work -- --resume ${sessionId}`);
        expect(result.drift).toEqual([`resume target "234567" replaced with the session that was active here`]);
    });

    test("keeps every other flag", () => {
        const result = deriveReplayCommand({ original: "cr work -m fable", sessionId });
        expect(result.command).toBe(`cr work -m fable -- --resume ${sessionId}`);
    });

    test("adds the pinned account right after the alias when the original had none", () => {
        const result = deriveReplayCommand({ original: "cr -m fable", sessionId, account: "work" });
        expect(result.command).toBe(`cr work -m fable -- --resume ${sessionId}`);
    });

    test("the pinned id survives into the profile and back out", () => {
        expect(resumeTargetFromCommand(`cr work -- --resume ${sessionId}`)).toBe(sessionId);
        expect(resumeTargetFromCommand("cr work --resume 234567")).toBeUndefined();
    });

    test("an alias is not a launcher once the override is cleared and none is discovered", () => {
        setCcRunAliases([]);
        try {
            expect(isAgentLauncher("cr work")).toBe(false);
        } finally {
            setCcRunAliases(["cr"]);
        }
    });
});

describe("discoverCcRunAliases", () => {
    test("names the wrappers whose body execs tools cc run, and nothing else", () => {
        const dir = mkdtempSync(join(tmpdir(), "cc-run-aliases-"));
        writeFileSync(join(dir, "cr"), '#!/usr/bin/env bash\n# cr\nexec tools cc run "$@"\n');
        writeFileSync(join(dir, "cu"), '#!/usr/bin/env bash\nexec tools cc usage "$@"\n');
        writeFileSync(join(dir, "ccr"), '#!/usr/bin/env bash\nexec tools claude run "$@"\n');
        writeFileSync(join(dir, "notes.ts"), 'const x = "exec tools cc run";\n');
        chmodSync(join(dir, "cr"), 0o755);

        expect(discoverCcRunAliases(dir)).toEqual(["ccr", "cr"]);
    });

    test("a missing directory yields no aliases", () => {
        expect(discoverCcRunAliases(join(tmpdir(), "does-not-exist-cc-run-aliases"))).toEqual([]);
    });
});

describe("claudeSessionFromArgv", () => {
    const id = "f2f57edd-be32-4dae-be97-3fc3923afca9";

    test("reads the concrete uuid a live claude process resumes", () => {
        expect(claudeSessionFromArgv(`/Users/x/.bun/bin/claude --dangerously-skip-permissions --resume ${id}`)).toBe(
            id
        );
        expect(claudeSessionFromArgv(`claude --resume ${id.toUpperCase()}`)).toBe(id);
    });

    test("a fresh session, a bare picker or a fuzzy query has no id", () => {
        expect(claudeSessionFromArgv("/Users/x/.bun/bin/claude --dangerously-skip-permissions")).toBeUndefined();
        expect(claudeSessionFromArgv("claude --resume")).toBeUndefined();
        expect(claudeSessionFromArgv("claude --resume 234567")).toBeUndefined();
    });

    test("only a claude process counts", () => {
        expect(claudeSessionFromArgv(`bun tools claude mcp --resume ${id}`)).toBeUndefined();
        expect(claudeSessionFromArgv(`grok -r ${id}`)).toBeUndefined();
    });
});
describe("resumeQueryFromCommand", () => {
    test("names the query a cc run launcher will search for", () => {
        expect(resumeQueryFromCommand("tools claude run foltyn --resume astra")).toBe("astra");
        expect(resumeQueryFromCommand("cr bfbc --resume report")).toBe("report");
    });

    test("a pinned id and a cold start are not queries", () => {
        const id = "f2f57edd-be32-4dae-be97-3fc3923afca9";
        expect(resumeQueryFromCommand(`cr bfbc -- --resume ${id}`)).toBeUndefined();
        expect(resumeQueryFromCommand("cr bfbc")).toBeUndefined();
        expect(resumeQueryFromCommand("ncdu /tmp")).toBeUndefined();
    });
});

describe("loadSurfaceSessions", () => {
    // The cmux SessionStart hook is shared by all three agents but only started
    // tagging its records in 2026-09: 3723 of the 3725 lines on this machine are
    // untagged, 29 of them Codex rollouts. Reading those as Claude is what types
    // a Codex thread id into `claude --resume`.
    function line(sessionId: string, surfaceId: string, provider?: string): string {
        return SafeJSON.stringify({
            sessionId,
            ...(provider ? { provider } : {}),
            workspaceId: null,
            surfaceId,
            workspaceRef: null,
            paneRef: null,
            surfaceRef: null,
            windowRef: null,
            tmuxPane: null,
            cwd: null,
            at: Date.now(),
        });
    }

    function pinLine(sessionId: string, provider?: string): string {
        return SafeJSON.stringify({
            sessionId,
            ...(provider ? { provider } : {}),
            account: null,
            model: null,
            cwd: "/tmp",
            workspaceId: null,
            source: "hook",
            at: Date.now(),
        });
    }

    test("an untagged record counts as Claude's only with Claude's UUIDv4 shape", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cmux-refs-"));
        const refsPath = join(dir, "cmux-refs.jsonl");
        const pinsPath = join(dir, "session-pins.jsonl");
        writeFileSync(
            refsPath,
            [
                line("6bdfb457-cee9-4202-8105-21be8a801757", "surface-v4"),
                line("01a08283-d374-7ab3-bcc5-72f83340a153", "surface-v7"),
                line("01a08207-a472-7061-ae94-8dfc9f0ad887", "surface-tagged", "codex"),
            ].join("\n")
        );
        // Hermetic: without its own pin journal this read reached the developer's
        // real `~/.genesis-tools/claude-code/session-pins.jsonl`.
        writeFileSync(pinsPath, "");

        const sessions = await loadSurfaceSessions({ refsPath, pinsPath });

        // The negative control: an ordinary Claude record and a tagged Codex
        // record both still resolve, so the guard did not disable the journal.
        expect(sessions.get("surface-v4")).toMatchObject({
            provider: "claude",
            sessionId: "6bdfb457-cee9-4202-8105-21be8a801757",
        });
        expect(sessions.get("surface-tagged")).toMatchObject({
            provider: "codex",
            sessionId: "01a08207-a472-7061-ae94-8dfc9f0ad887",
        });
        expect(sessions.has("surface-v7")).toBe(false);
    });

    // A session the user ended with /exit must not come back at the next relaunch, and neither may an older
    // session of the same tab. A crash writes no such record, so a crashed session still resumes.
    test("a tab whose newest record is a deliberate end has no session to resume", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cmux-refs-"));
        const refsPath = join(dir, "cmux-refs.jsonl");
        const pinsPath = join(dir, "session-pins.jsonl");
        const older = SafeJSON.parse(line("aaaaaaaa-1111-4111-8111-111111111111", "surface-exited"));
        const exited = SafeJSON.parse(line("bbbbbbbb-2222-4222-8222-222222222222", "surface-exited"));
        writeFileSync(
            refsPath,
            [
                SafeJSON.stringify({ ...older, at: Date.now() - 60_000 }),
                SafeJSON.stringify({ ...exited, at: Date.now() - 30_000 }),
                SafeJSON.stringify({ ...exited, ended: true }),
                line("cccccccc-3333-4333-8333-333333333333", "surface-crashed"),
            ].join("\n")
        );
        writeFileSync(pinsPath, "");

        const sessions = await loadSurfaceSessions({ refsPath, pinsPath });

        expect(sessions.has("surface-exited")).toBe(false);
        expect(sessions.get("surface-crashed")?.sessionId).toBe("cccccccc-3333-4333-8333-333333333333");
    });

    // The v4 shape is Claude's habit, not a law. The shared index holds 4 Codex
    // and 6 Grok sessions with v4-shaped ids, and the id alone cannot tell them
    // apart. The pin journal can: it is written per session by the same hook and
    // names the provider outright.
    test("a pin that names another agent overrules the id shape", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cmux-refs-"));
        const refsPath = join(dir, "cmux-refs.jsonl");
        const pinsPath = join(dir, "session-pins.jsonl");
        writeFileSync(
            refsPath,
            [
                line("751f3deb-2215-4040-8947-9b2000dd22b7", "surface-grok-v4"),
                line("6bdfb457-cee9-4202-8105-21be8a801757", "surface-claude-v4"),
            ].join("\n")
        );
        writeFileSync(
            pinsPath,
            [
                pinLine("751f3deb-2215-4040-8947-9b2000dd22b7", "grok"),
                // The negative control: an untagged pin is Claude's own, so the
                // Claude record must still resolve.
                pinLine("6bdfb457-cee9-4202-8105-21be8a801757"),
            ].join("\n")
        );

        const sessions = await loadSurfaceSessions({ refsPath, pinsPath });

        expect(sessions.get("surface-grok-v4")).toMatchObject({ provider: "grok" });
        expect(sessions.get("surface-claude-v4")).toMatchObject({ provider: "claude" });
    });
});

// The user starts agents through aliases, functions and wrappers this code has never seen. The tab's
// surface journal is the evidence of which session ran there, not the words typed.
describe("journalReplayCommand", () => {
    const CLAUDE_ID = "6bdfb457-cee9-4202-8105-21be8a801757";
    const session = { sessionId: CLAUDE_ID, provider: "claude" as const, account: "work", at: 2_000 };

    test("an unknown launcher resumes the session the surface journal saw after it started", () => {
        const resolved = journalReplayCommand({ command: "myclaude --fast", atMs: 1_000 }, session);

        expect(resolved.command).toBe(`tools claude start work -- --resume ${CLAUDE_ID}`);
        expect(resolved.drift[0]).toContain(`claude session ${CLAUDE_ID}`);
    });

    test("a command typed after the session's last record replays verbatim", () => {
        expect(journalReplayCommand({ command: "tail -f app.log", atMs: 3_000 }, session)).toEqual({
            command: "tail -f app.log",
            drift: [],
        });
    });

    test("a known launcher is left for the replay path to pin", () => {
        expect(journalReplayCommand({ command: "cr work", atMs: 1_000 }, session).command).toBe("cr work");
    });

    test("a session read off a live process carries no record time and never rewrites the line", () => {
        const live = { sessionId: CLAUDE_ID, provider: "claude" as const };

        expect(journalReplayCommand({ command: "myclaude", atMs: 1_000 }, live).command).toBe("myclaude");
    });
});

// cmux types `cmux restore <kind> <id>` itself at relaunch, from its own record, which can be stale.
describe("journalReplayCommand with cmux's own restore line", () => {
    const CLAUDE_ID = "6bdfb457-cee9-4202-8105-21be8a801757";
    const GROK_ID = "b4d9d27d-1597-48fd-b6a6-f5ed76feb360";
    // The journal record is OLDER than the line: cmux typed it after the crash, so time does not count.
    const claude = { sessionId: CLAUDE_ID, provider: "claude" as const, account: "work", at: 1_000 };

    test("the surface journal's session wins over a stale cmux restore line", () => {
        const resolved = journalReplayCommand({ command: ` cmux restore grok ${GROK_ID}`, atMs: 2_000 }, claude);

        expect(resolved.command).toBe(`tools claude start work -- --resume ${CLAUDE_ID}`);
        expect(resolved.drift[0]).toContain(`cmux's own restore typed \`cmux restore grok ${GROK_ID}\``);
    });

    test("with no other journal session the line becomes the agent's own resume", () => {
        expect(journalReplayCommand({ command: ` cmux restore grok ${GROK_ID}`, atMs: 2_000 }).command).toBe(
            `grok -r ${GROK_ID}`
        );
    });
});

// The user can switch models inside a session; a resume must never pin the model the tab started with.
describe("stripModelFlags", () => {
    test("drops -m, --model and --model= on either side of --", () => {
        expect(stripModelFlags("cr work -m sonnet -- --resume abc")).toEqual({
            command: "cr work -- --resume abc",
            removed: ["-m sonnet"],
        });
        expect(
            stripModelFlags("tools claude run work --model opus --cross-messages -- --model=haiku --resume abc")
        ).toEqual({
            command: "tools claude run work --cross-messages -- --resume abc",
            removed: ["--model opus", "--model=haiku"],
        });
        expect(stripModelFlags("grok -r abc")).toEqual({ command: "grok -r abc", removed: [] });
    });
});
