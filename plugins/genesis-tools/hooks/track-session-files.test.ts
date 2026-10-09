import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * All three harnesses run this hook, and they name their edit tools differently. The matcher
 * narrows each of them (Claude's own names, Codex 0.155 `apply_patch` via Edit|Write, Grok
 * 1.0.44 `search_replace` and `write`). A name that still gets through and is not in
 * `EDIT_TOOLS` is tallied, which is how a new edit name becomes visible instead of vanishing.
 */

const HOOK = join(import.meta.dir, "track-session-files.ts");
let home: string;

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<number> {
    const proc = Bun.spawn(["bun", HOOK], {
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GENESIS_TOOLS_HOME: home, ...env },
    });

    return await proc.exited;
}

async function readJson<T>(...segments: string[]): Promise<T> {
    return JSON.parse(await readFile(join(home, ".genesis-tools", "claude-code", ...segments), "utf8")) as T;
}

const CLAUDE_TRANSCRIPT = "/Users/u/.claude/projects/p/s1.jsonl";
const CODEX_TRANSCRIPT = "/Users/u/.codex/sessions/2026/09/11/rollout-2026-09-11T10-00-00-s2.jsonl";

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "track-files-"));
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

test("a claude edit is tracked from tool_input.file_path", async () => {
    expect(
        await runHook({
            session_id: "s1",
            hook_event_name: "PostToolUse",
            tool_name: "Edit",
            tool_input: { file_path: "/repo/a.ts" },
            transcript_path: CLAUDE_TRANSCRIPT,
        })
    ).toBe(0);

    expect((await readJson<{ files: string[] }>("sessions", "s1.json")).files).toEqual(["/repo/a.ts"]);
});

test("an edit tool that names its path in another field is still tracked", async () => {
    // Claude puts it in `tool_input.file_path`; the candidates for the other harnesses use
    // `path`. Reading only Claude's field is why this hook did nothing outside Claude.
    await runHook({
        session_id: "s2",
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        tool_input: { path: "/repo/b.ts" },
        transcript_path: CODEX_TRANSCRIPT,
    });

    expect((await readJson<{ files: string[] }>("sessions", "s2.json")).files).toEqual(["/repo/b.ts"]);
});

// Regression test: Codex 0.154 apply_patch hooks serialize paths inside tool_input.command,
// relative to the payload's cwd. The seeding Edit carries no cwd, so its path stays as given.
test("a Codex apply_patch payload tracks its complete path set, absolute against its cwd", async () => {
    await runHook({
        session_id: "s2-patch",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "src/seed.ts" },
        transcript_path: CLAUDE_TRANSCRIPT,
    });

    expect(
        await runHook({
            session_id: "s2-patch",
            hook_event_name: "PostToolUse",
            tool_name: "apply_patch",
            cwd: "/repo",
            tool_input: {
                command: [
                    "*** Begin Patch",
                    "*** Add File: src/added.ts",
                    "+added",
                    "*** Update File: src/original.ts",
                    "*** Move to: src/moved.ts",
                    "@@",
                    "-old",
                    "+new",
                    "*** Delete File: src/deleted.ts",
                    "*** End Patch",
                ].join("\n"),
            },
            tool_response:
                "Exit code: 0\nSuccess. Updated the following files:\nA src/added.ts\nM src/moved.ts\nD src/deleted.ts",
            transcript_path: CODEX_TRANSCRIPT,
        })
    ).toBe(0);

    expect((await readJson<{ files: string[] }>("sessions", "s2-patch.json")).files).toEqual([
        "src/seed.ts",
        resolve("/repo", "src/added.ts"),
        resolve("/repo", "src/original.ts"),
        resolve("/repo", "src/moved.ts"),
        resolve("/repo", "src/deleted.ts"),
    ]);
});

test("a rejected apply_patch tracks nothing: its string response leads with a non-zero exit code", async () => {
    expect(
        await runHook({
            session_id: "s2-rejected",
            hook_event_name: "PostToolUse",
            tool_name: "apply_patch",
            cwd: "/repo",
            tool_input: {
                command: ["*** Begin Patch", "*** Add File: src/never.ts", "+x", "*** End Patch"].join("\n"),
            },
            tool_response: "Exit code: 1\napply_patch: src/never.ts: file already exists",
            transcript_path: CODEX_TRANSCRIPT,
        })
    ).toBe(0);

    await expect(readJson("sessions", "s2-rejected.json")).rejects.toThrow();
});

test("an unrecognised tool is tallied by harness, so the vocabulary can be confirmed", async () => {
    await runHook({
        session_id: "s3",
        hook_event_name: "PostToolUse",
        tool_name: "mystery_tool",
        transcript_path: CODEX_TRANSCRIPT,
    });
    await runHook({
        session_id: "s3",
        hook_event_name: "PostToolUse",
        tool_name: "mystery_tool",
        transcript_path: CODEX_TRANSCRIPT,
    });

    // The NAME and the harness, never the arguments: this file is a vocabulary, not a transcript.
    expect(await readJson<Record<string, number>>("hook-tool-names.json")).toEqual({ "codex:mystery_tool": 2 });
});

test("a tally file holding valid JSON of the wrong shape recovers instead of dying forever", async () => {
    // `JSON.parse` does not throw on `null`, a string, or an array — it is still valid
    // JSON, just not the `Record<string, number>` this file assumes. `Object.keys(null)`
    // throws further down, and that used to land in the outer bare `catch {}` with nothing
    // logged, on every later run.
    const dir = join(home, ".genesis-tools", "claude-code");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "hook-tool-names.json"), "null");

    expect(
        await runHook({
            session_id: "s4",
            hook_event_name: "PostToolUse",
            tool_name: "mystery_tool",
            transcript_path: CODEX_TRANSCRIPT,
        })
    ).toBe(0);

    expect(await readJson<Record<string, number>>("hook-tool-names.json")).toEqual({ "codex:mystery_tool": 1 });
});

// Regression test: Grok 1.0.44 tool tally on 2026-09-29 — search_replace was counted and the file was not tracked.
test("a grok search_replace records the file it names", async () => {
    expect(
        await runHook({
            session_id: "s-grok",
            hook_event_name: "PostToolUse",
            tool_name: "search_replace",
            tool_input: { file_path: "/repo/g.ts" },
            transcript_path: "/Users/u/.grok/sessions/chat.jsonl",
        })
    ).toBe(0);

    expect((await readJson<{ files: string[] }>("sessions", "s-grok.json").catch(() => ({ files: [] }))).files).toEqual(
        ["/repo/g.ts"]
    );
});

// Regression test: Grok's stdin is camelCase (sessionId, toolName, toolInput) and 1.0.44 names the create tool `write`.
test("a grok write in the camelCase envelope records the file", async () => {
    expect(
        await runHook({
            sessionId: "s-grok-write",
            hookEventName: "post_tool_use",
            toolName: "write",
            toolInput: { file_path: "/repo/h.ts" },
            transcriptPath: "/Users/u/.grok/sessions/chat.jsonl",
        })
    ).toBe(0);

    expect(
        (await readJson<{ files: string[] }>("sessions", "s-grok-write.json").catch(() => ({ files: [] }))).files
    ).toEqual(["/repo/h.ts"]);
});

test("a grok write that reports failure through toolResult is not tracked", async () => {
    expect(
        await runHook({
            sessionId: "s-grok-fail",
            hookEventName: "post_tool_use",
            toolName: "write",
            toolInput: { file_path: "/repo/nope.ts" },
            toolResult: { success: false },
            transcriptPath: "/Users/u/.grok/sessions/chat.jsonl",
        })
    ).toBe(0);

    await expect(readJson("sessions", "s-grok-fail.json")).rejects.toThrow();
});

test("a failed write is not tracked, on any harness", async () => {
    await runHook({
        session_id: "s4",
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/repo/c.ts" },
        tool_response: { success: false },
        transcript_path: CLAUDE_TRANSCRIPT,
    });

    expect(readJson<unknown>("sessions", "s4.json")).rejects.toThrow();
});

test("concurrent hook processes preserve the union of edited paths", async () => {
    const paths = Array.from({ length: 16 }, (_, index) => `/repo/concurrent-${index}.ts`);

    const exits = await Promise.all(
        paths.map((filePath) =>
            runHook({
                session_id: "shared-session",
                hook_event_name: "PostToolUse",
                tool_name: "Edit",
                tool_input: { file_path: filePath },
                transcript_path: CLAUDE_TRANSCRIPT,
            })
        )
    );

    expect(exits).toEqual(paths.map(() => 0));
    expect((await readJson<{ files: string[] }>("sessions", "shared-session.json")).files.sort()).toEqual(paths.sort());
});

test("concurrent hooks recover from a preseeded stale lock without losing an edit", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => `/repo/stale-${index}.ts`);
    const sessions = join(home, ".genesis-tools", "claude-code", "sessions");
    await mkdir(sessions, { recursive: true });
    // A holder pid that cannot be alive: every waiter sees the same dead owner at once.
    await writeFile(join(sessions, "stale-session.json.lock"), JSON.stringify({ pid: 2 ** 31 - 2, at: 0 }));

    const exits = await Promise.all(
        paths.map((filePath) =>
            runHook({
                session_id: "stale-session",
                hook_event_name: "PostToolUse",
                tool_name: "Edit",
                tool_input: { file_path: filePath },
                transcript_path: CLAUDE_TRANSCRIPT,
            })
        )
    );

    expect(exits).toEqual(paths.map(() => 0));
    expect((await readJson<{ files: string[] }>("sessions", "stale-session.json")).files.sort()).toEqual(paths.sort());
});

function editPayload(sessionId: string, filePath: string) {
    return {
        session_id: sessionId,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: filePath },
        transcript_path: CLAUDE_TRANSCRIPT,
    };
}

// Regression test: CI 2026-10-08/09, a hook that waited out the 1 s lock deadline exited 1 and its edit was never written.
test("an edit that waits out the lock deadline is spooled, and the next lock holder records it", async () => {
    const sessions = join(home, ".genesis-tools", "claude-code", "sessions");
    const lock = join(sessions, "busy-session.json.lock");
    await mkdir(sessions, { recursive: true });
    // This test process is alive and the lock is fresh, so nothing may break it: the hook must time out.
    await writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));

    expect(
        await runHook(editPayload("busy-session", "/repo/waited.ts"), { GENESIS_TOOLS_SESSION_LOCK_WAIT_MS: "150" })
    ).toBe(0);
    await expect(readJson("sessions", "busy-session.json")).rejects.toThrow();

    await rm(lock);
    expect(await runHook(editPayload("busy-session", "/repo/next.ts"))).toBe(0);

    expect((await readJson<{ files: string[] }>("sessions", "busy-session.json")).files.sort()).toEqual([
        "/repo/next.ts",
        "/repo/waited.ts",
    ]);
    expect(await readdir(join(sessions, "busy-session.json.pending"))).toEqual([]);
});

// Regression test: a takeover marker was broken after 2 s even with its owner alive, so a paused recoverer could unlink a fresh lock.
test("a live hook's takeover marker is never broken, however old it is", async () => {
    const sessions = join(home, ".genesis-tools", "claude-code", "sessions");
    const lock = join(sessions, "takeover-session.json.lock");
    const takeover = `${lock}.takeover`;
    await mkdir(sessions, { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: 2 ** 31 - 2, at: 0 }));
    // A recoverer that is alive but paused mid-takeover: its marker is old, its pid is this process.
    await writeFile(takeover, JSON.stringify({ pid: process.pid, at: 0 }));
    const fiveSecondsAgo = new Date(Date.now() - 5_000);
    await utimes(takeover, fiveSecondsAgo, fiveSecondsAgo);

    expect(
        await runHook(editPayload("takeover-session", "/repo/paused.ts"), { GENESIS_TOOLS_SESSION_LOCK_WAIT_MS: "300" })
    ).toBe(0);

    // The paused recoverer still owns the takeover, so the stale lock it is handling was left alone.
    expect(JSON.parse(await readFile(lock, "utf8"))).toEqual({ pid: 2 ** 31 - 2, at: 0 });
    expect(JSON.parse(await readFile(takeover, "utf8"))).toEqual({ pid: process.pid, at: 0 });

    await rm(takeover);
    expect(await runHook(editPayload("takeover-session", "/repo/after.ts"))).toBe(0);
    expect((await readJson<{ files: string[] }>("sessions", "takeover-session.json")).files.sort()).toEqual([
        "/repo/after.ts",
        "/repo/paused.ts",
    ]);
});

test("repeated SessionStart runs cleanup at most once per cadence", async () => {
    const payload = {
        session_id: "start-session",
        hook_event_name: "SessionStart",
        transcript_path: CLAUDE_TRANSCRIPT,
    };
    await mkdir(join(home, ".genesis-tools", "claude-code", "sessions"), { recursive: true });

    await runHook(payload);
    const stamp = join(home, ".genesis-tools", "claude-code", "sessions", ".cleanup-stamp");
    const first = await readFile(stamp, "utf8");
    await runHook(payload);

    expect(await readFile(stamp, "utf8")).toBe(first);
});
