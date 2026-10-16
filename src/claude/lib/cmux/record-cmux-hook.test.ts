import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeArgv } from "@genesiscz/utils/agent-sessions/resume-argv";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { SafeJSON } from "@genesiscz/utils/json";
import { clearResumeBinding, syncResumeBinding } from "../../../../plugins/genesis-tools/hooks/record-session-cmux";
import { isHeadlessAgent } from "../../../../plugins/genesis-tools/lib/agent-process";
import { resumeArgv as pluginResumeArgv } from "../../../../plugins/genesis-tools/lib/resume-argv";

/**
 * Like record-hook.test.ts: the cmux-refs hook is a standalone plugin script
 * (it cannot import src/), so it is tested the way Claude Code runs it — a
 * real process, payload on stdin, assertions on the journal it leaves behind.
 *
 * The tty gate exists because a headless child (`claude -p` from a Bash tool)
 * inherits the parent's CMUX_SURFACE_ID and, recorded, RELABELS the parent's
 * tab — `cmux tree` and monitor presence then call the pane's real session
 * "not in cmux" (2026-09-01, surface:108).
 */
const HOOK = join(
    findProjectRoot(import.meta.dir) ?? process.cwd(),
    "plugins/genesis-tools/hooks/record-session-cmux.ts"
);

let home: string;

async function runHook(payload: string, env: Record<string, string> = {}): Promise<number> {
    const proc = Bun.spawn(["bun", HOOK], {
        stdin: new TextEncoder().encode(payload),
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            GENESIS_TOOLS_HOME: home,
            CMUX_WORKSPACE_ID: "TEST-WS",
            CMUX_SURFACE_ID: "TEST-SURFACE",
            TMUX_PANE: "",
            CLAUDE_PID: "",
            ...env,
        },
    });

    return await proc.exited;
}

async function readJournal(): Promise<Record<string, unknown>[]> {
    const path = join(home, ".genesis-tools", "claude-code", "cmux-refs.jsonl");
    const text = await readFile(path, "utf8").catch(() => "");

    return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => SafeJSON.parse(line, { strict: true }) as Record<string, unknown>);
}

const PAYLOAD = SafeJSON.stringify({ session_id: "11111111-aaaa-bbbb-cccc-000000000001", cwd: "/tmp" });

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "record-cmux-hook-"));
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

// The journal took a line per prompt per agent (19,203 lines in seven days) and every prompt paid a cmux identify.
describe("record-session-cmux heartbeat", () => {
    const prompt = (sessionId: string) =>
        SafeJSON.stringify({ session_id: sessionId, cwd: "/tmp", hook_event_name: "UserPromptSubmit" });
    const start = SafeJSON.stringify({
        session_id: "11111111-aaaa-bbbb-cccc-000000000001",
        cwd: "/tmp",
        hook_event_name: "SessionStart",
    });

    test("a prompt in the same tab within the heartbeat writes nothing; a start, a new tab or another session does", async () => {
        await runHook(start);
        await runHook(prompt("11111111-aaaa-bbbb-cccc-000000000001"));
        expect(await readJournal()).toHaveLength(1);

        await runHook(prompt("11111111-aaaa-bbbb-cccc-000000000001"), { CMUX_SURFACE_ID: "MOVED-SURFACE" });
        await runHook(prompt("22222222-aaaa-bbbb-cccc-000000000002"));
        await runHook(start);
        const lines = await readJournal();
        expect(lines.map((line) => line.surfaceId)).toEqual([
            "TEST-SURFACE",
            "MOVED-SURFACE",
            "TEST-SURFACE",
            "TEST-SURFACE",
        ]);
    });

    test.each(["identify", "set"])("a failed %s is retried before the journal heartbeat expires", async (failure) => {
        const bin = join(home, "bin");
        const calls = join(home, "calls");
        await mkdir(bin, { recursive: true });
        await writeFile(
            join(bin, "cmux"),
            `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_DIR/calls"
case "$*" in
  *identify*)
    if [ "$FIXTURE_FAILURE" = identify ] && [ ! -f "$FIXTURE_DIR/failed" ]; then
      : > "$FIXTURE_DIR/failed"
      exit 1
    fi
    printf '%s\\n' '{"caller":{"surface_id":"6A7AC7A4-E510-4A41-85DE-080C21078EA7"}}'
    ;;
  'surface resume set '*)
    if [ "$FIXTURE_FAILURE" = set ] && [ ! -f "$FIXTURE_DIR/failed" ]; then
      : > "$FIXTURE_DIR/failed"
      exit 1
    fi
    ;;
  'surface resume clear '*) ;;
  *) exit 1 ;;
esac
`,
            { mode: 0o755 }
        );
        const fixtureEnv = {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            FIXTURE_DIR: home,
            FIXTURE_FAILURE: failure,
            CMUX_SURFACE_ID: "6a7ac7a4-e510-4a41-85de-080c21078ea7",
        };
        const sessionId = "11111111-aaaa-bbbb-cccc-000000000001";
        expect(await runHook(start, fixtureEnv)).toBe(0);
        expect(await runHook(prompt(sessionId), fixtureEnv)).toBe(0);
        const retried = (await readFile(calls, "utf8")).trim().split("\n");
        expect(retried.filter((line) => line.includes("identify"))).toHaveLength(2);
        expect(retried.filter((line) => line.startsWith("surface resume set"))).toHaveLength(failure === "set" ? 2 : 1);
        expect(await readJournal()).toHaveLength(1);
        expect(await runHook(prompt(sessionId), fixtureEnv)).toBe(0);
        expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(retried);
        expect(
            await runHook(
                SafeJSON.stringify({
                    session_id: sessionId,
                    hook_event_name: "SessionEnd",
                    reason: "prompt_input_exit",
                }),
                fixtureEnv
            )
        ).toBe(0);
        expect((await readFile(calls, "utf8")).trim().split("\n").at(-1)).toContain("surface resume clear");
    });

    test("a prompt after the heartbeat writes again", async () => {
        await runHook(prompt("11111111-aaaa-bbbb-cccc-000000000001"));
        const statePath = join(home, ".genesis-tools", "claude-code", "cmux-refs-last.json");
        const state = SafeJSON.parse(await readFile(statePath, "utf8"), { strict: true }) as Record<
            string,
            { at: number }
        >;
        state["11111111-aaaa-bbbb-cccc-000000000001"].at -= 31 * 60_000;
        await Bun.write(statePath, SafeJSON.stringify(state));

        await runHook(prompt("11111111-aaaa-bbbb-cccc-000000000001"));
        expect(await readJournal()).toHaveLength(2);
    });
});

describe("record-session-cmux tty gate", () => {
    test("a headless claude (tty '??') is not recorded", async () => {
        // A detached sleep (its own session) has no controlling tty, same as `claude -p`.
        // A plain child would inherit the terminal of a `bun test` run from a shell.
        const headless = Bun.spawn(["sleep", "30"], {
            env: process.env,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: true,
        });

        try {
            await runHook(PAYLOAD, { CLAUDE_PID: String(headless.pid) });
            expect(await readJournal()).toEqual([]);
        } finally {
            headless.kill();
        }
    });

    test("no CLAUDE_PID fails open and records", async () => {
        await runHook(PAYLOAD);
        const entries = await readJournal();

        expect(entries).toHaveLength(1);
        expect(entries[0].sessionId).toBe("11111111-aaaa-bbbb-cccc-000000000001");
        expect(entries[0].surfaceId).toBe("TEST-SURFACE");
        expect(entries[0].provider).toBeUndefined();
    });

    test("a dead CLAUDE_PID fails open and records", async () => {
        // A pid ps cannot answer for must not read as "headless": losing the
        // journal entirely is worse than one stray line.
        await runHook(PAYLOAD, { CLAUDE_PID: "999999" });

        expect(await readJournal()).toHaveLength(1);
    });

    test("no cmux surface and no tmux pane records nothing", async () => {
        await runHook(PAYLOAD, { CMUX_SURFACE_ID: "", CMUX_WORKSPACE_ID: "" });

        expect(await readJournal()).toEqual([]);
    });

    test("a grok payload is tagged grok instead of an untagged claude line", async () => {
        // Grok's hook stdin uses sessionId and hookEventName, and often no transcript.
        // An untagged line would claim the pane for `tools claude who`.
        await runHook(
            SafeJSON.stringify({
                sessionId: "01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
                hookEventName: "user_prompt_submit",
                cwd: "/tmp/grok-session",
            })
        );
        const entries = await readJournal();

        expect(entries).toHaveLength(1);
        expect(entries[0].provider).toBe("grok");
        expect(entries[0].sessionId).toBe("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee");
        expect(entries[0].surfaceId).toBe("TEST-SURFACE");
    });

    test("a transcript under a .grok home is grok even when the id field is session_id", async () => {
        await runHook(
            SafeJSON.stringify({
                session_id: "01a0bbbb-cccc-7ddd-8eee-ffffffffffff",
                transcript_path: "/tmp/fake/.grok/sessions/chat.jsonl",
                cwd: "/tmp/grok-session",
            })
        );

        expect((await readJournal())[0]?.provider).toBe("grok");
    });
});

describe("record-session-cmux: which agent owns the tab", () => {
    test("headless runs of each agent are told apart from their terminal UIs", () => {
        expect(isHeadlessAgent({ harness: "claude", command: "/Users/me/.bun/bin/claude -p hello" })).toBe(true);
        expect(isHeadlessAgent({ harness: "claude", command: "claude --input-format stream-json" })).toBe(true);
        expect(isHeadlessAgent({ harness: "claude", command: "claude --resume 6bdfb457" })).toBe(false);
        expect(isHeadlessAgent({ harness: "grok", command: "/Users/me/.local/bin/grok -r abc -p fix it" })).toBe(true);
        expect(isHeadlessAgent({ harness: "grok", command: "/Users/me/.local/bin/grok -r abc" })).toBe(false);
        expect(isHeadlessAgent({ harness: "codex", command: "node /opt/codex/bin/codex.js exec --json" })).toBe(true);
        expect(isHeadlessAgent({ harness: "codex", command: "/usr/local/bin/codex app-server" })).toBe(true);
        expect(isHeadlessAgent({ harness: "codex", command: "/usr/local/bin/codex resume 019a" })).toBe(false);
    });

    // 2026-10-14: a Codex app-server and a grok worker started from a Claude tab inherited its CLAUDE_PID and
    // CMUX_SURFACE_ID, passed the old claude-only tty check, and wrote their sessions onto the Claude tab.
    test("a headless Codex started from a Claude tab is not recorded, whatever CLAUDE_PID says", async () => {
        const agentDir = await mkdtemp(join(tmpdir(), "record-cmux-agent-"));
        const fakeCodex = join(agentDir, "codex.ts");
        await Bun.write(
            fakeCodex,
            `const hook = Bun.spawn(["bun", ${SafeJSON.stringify(HOOK)}], { stdin: new TextEncoder().encode(await Bun.stdin.text()), stdout: "ignore", stderr: "ignore" });\nprocess.exit(await hook.exited);\n`
        );

        try {
            const proc = Bun.spawn(["bun", fakeCodex, "exec", "--json"], {
                stdin: new TextEncoder().encode(
                    SafeJSON.stringify({
                        session_id: "019a0000-0000-7000-8000-000000000001",
                        transcript_path: "/tmp/fake/.codex/sessions/rollout-1.jsonl",
                        cwd: "/tmp",
                    })
                ),
                env: {
                    ...process.env,
                    GENESIS_TOOLS_HOME: home,
                    CMUX_WORKSPACE_ID: "TEST-WS",
                    CMUX_SURFACE_ID: "TEST-SURFACE",
                    TMUX_PANE: "",
                    CLAUDE_PID: String(process.pid),
                },
            });
            await proc.exited;

            expect(await readJournal()).toEqual([]);
        } finally {
            await rm(agentDir, { recursive: true, force: true });
        }
    });

    test("the hook's resume command equals the one restore-after-restart builds", () => {
        for (const harness of ["claude", "codex", "grok"] as const) {
            for (const account of [undefined, "work"]) {
                expect(pluginResumeArgv(harness, "6bdfb457-cee9-4202-8105-21be8a801757", account)).toEqual(
                    resumeArgv(harness, "6bdfb457-cee9-4202-8105-21be8a801757", account)
                );
            }
        }
    });
});

test("publishes the resume-binding hooks with a newer, consistent plugin version", async () => {
    const root = findProjectRoot(import.meta.dir) ?? process.cwd();
    const plugin: { version: string } = SafeJSON.parse(
        await readFile(join(root, "plugins/genesis-tools/.claude-plugin/plugin.json"), "utf8")
    );
    const marketplace: { version: string; plugins: Array<{ name: string; version: string }> } = SafeJSON.parse(
        await readFile(join(root, ".claude-plugin/marketplace.json"), "utf8")
    );
    // 1.0.107 predates the SessionEnd hook and per-surface resume bindings.
    expect(Bun.semver.satisfies(plugin.version, ">1.0.107")).toBe(true);
    expect(marketplace.version).toBe(plugin.version);
    expect(marketplace.plugins.find((entry) => entry.name === "genesis-tools")?.version).toBe(plugin.version);
});

describe("record-session-cmux: the cmux resume binding", () => {
    const SURFACE = "6A7AC7A4-E510-4A41-85DE-080C21078EA7";

    test("overlapping starts retain both surfaces so either session can clear its binding", () => {
        const firstSurface = "aaaaaaaa-0000-4000-8000-000000000003";
        const secondSurface = "bbbbbbbb-0000-4000-8000-000000000004";
        const firstSession = "aaaaaaaa-1111-4111-8111-000000000003";
        const secondSession = "bbbbbbbb-2222-4222-8222-000000000004";
        const calls: string[][] = [];
        const run = (args: string[]) => {
            calls.push(args);
            return true;
        };
        const base = { harness: "claude" as const, cwd: "/tmp/app", now: 1_000 };
        expect(
            syncResumeBinding({
                ...base,
                surfaceId: firstSurface,
                sessionId: firstSession,
                run: (args) => {
                    calls.push(args);
                    expect(
                        syncResumeBinding({ ...base, surfaceId: secondSurface, sessionId: secondSession, run })
                    ).toBe(true);
                    return true;
                },
            })
        ).toBe(true);
        expect(clearResumeBinding({ surfaceId: secondSurface, sessionId: secondSession, run })).toBe(true);
        expect(clearResumeBinding({ surfaceId: firstSurface, sessionId: firstSession, run })).toBe(true);
        expect(calls.filter((args) => args[2] === "clear").map((args) => args.at(-1))).toEqual([
            secondSurface,
            firstSurface,
        ]);
    });

    test("normalizes legacy uppercase keys and clears a lowercase exit without clearing another session", async () => {
        const sessionId = "cccccccc-3333-4333-8333-333333333333";
        const directory = join(process.env.GENESIS_TOOLS_HOME ?? "", ".genesis-tools", "claude-code");
        await mkdir(directory, { recursive: true });
        const stateFile = join(directory, "cmux-bindings.json");
        const argv = resumeArgv("claude", sessionId, "work");
        await writeFile(
            stateFile,
            SafeJSON.stringify({ [SURFACE]: { sessionId, command: argv.join(" "), at: 1_000 } })
        );
        const calls: string[][] = [];
        const run = (args: string[]) => {
            calls.push(args);
            return true;
        };

        expect(
            syncResumeBinding({
                surfaceId: SURFACE.toLowerCase(),
                harness: "claude",
                sessionId,
                account: "work",
                cwd: "/tmp/app",
                now: 2_000,
                run,
            })
        ).toBe(false);
        expect(calls).toHaveLength(0);
        expect(clearResumeBinding({ surfaceId: SURFACE.toLowerCase(), sessionId: "wrong-session", run })).toBe(false);
        expect(clearResumeBinding({ surfaceId: SURFACE.toLowerCase(), sessionId, run })).toBe(true);
        expect(calls).toEqual([["surface", "resume", "clear", "--surface", SURFACE.toLowerCase()]]);
        expect(clearResumeBinding({ surfaceId: SURFACE.toLowerCase(), sessionId, run })).toBe(false);
    });

    test("is set once per session and command, set again for a new session, and cleared only by its session", () => {
        const calls: string[][] = [];
        const run = (args: string[]) => {
            calls.push(args);
            return true;
        };
        const base = { surfaceId: SURFACE, harness: "claude" as const, cwd: "/tmp/app", account: "work", run };

        expect(syncResumeBinding({ ...base, sessionId: "aaaaaaaa-1111-4111-8111-111111111111", now: 1_000 })).toBe(
            true
        );
        expect(calls[0]).toEqual([
            "surface",
            "resume",
            "set",
            "--surface",
            SURFACE,
            "--kind",
            "agent",
            "--checkpoint",
            "aaaaaaaa-1111-4111-8111-111111111111",
            "--source",
            "genesis-tools",
            "--name",
            "claude aaaaaaaa",
            "--cwd",
            "/tmp/app",
            "--",
            "tools",
            "claude",
            "start",
            "work",
            "--",
            "--resume",
            "aaaaaaaa-1111-4111-8111-111111111111",
        ]);

        // The next prompt of the same session costs no cmux call; half an hour later it is set again.
        expect(syncResumeBinding({ ...base, sessionId: "aaaaaaaa-1111-4111-8111-111111111111", now: 2_000 })).toBe(
            false
        );
        expect(calls).toHaveLength(1);
        expect(
            syncResumeBinding({ ...base, sessionId: "aaaaaaaa-1111-4111-8111-111111111111", now: 1_000 + 31 * 60_000 })
        ).toBe(true);

        expect(syncResumeBinding({ ...base, sessionId: "bbbbbbbb-2222-4222-8222-222222222222", now: 3_000_000 })).toBe(
            true
        );
        expect(clearResumeBinding({ surfaceId: SURFACE, sessionId: "aaaaaaaa-1111-4111-8111-111111111111", run })).toBe(
            false
        );
        expect(clearResumeBinding({ surfaceId: SURFACE, sessionId: "bbbbbbbb-2222-4222-8222-222222222222", run })).toBe(
            true
        );
        expect(calls.at(-1)).toEqual(["surface", "resume", "clear", "--surface", SURFACE]);
    });
});
