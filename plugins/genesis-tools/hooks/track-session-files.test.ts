import { dlopen, FFIType } from "bun:ffi";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
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

function editPayload(sessionId: string, filePath: string) {
    return {
        session_id: sessionId,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: filePath },
        transcript_path: CLAUDE_TRANSCRIPT,
    };
}

const LOCK_EX_NB = 2 | 4;
const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/** Takes the session's kernel lock in this process, as a hook mid-edit would; the returned function releases it. */
function holdLock(lockPath: string): () => void {
    const fd = openSync(lockPath, "a", 0o600);
    expect(libc.symbols.flock(fd, LOCK_EX_NB)).toBe(0);

    return () => closeSync(fd);
}

const LONG_AGO = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

test("concurrent hooks recover at once from a holder that was killed mid-edit, and none loses an edit", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => `/repo/killed-${index}.ts`);
    const sessions = join(home, ".genesis-tools", "claude-code", "sessions");
    await mkdir(sessions, { recursive: true });
    // A real holder that dies without releasing: the kernel must free its lock, with no recovery step to race.
    const holder = Bun.spawn(
        [
            "bun",
            "-e",
            `const { dlopen, FFIType } = require("bun:ffi");
             const { openSync } = require("node:fs");
             const libc = dlopen(${JSON.stringify(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6")}, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
             if (libc.symbols.flock(openSync(process.argv[1], "a"), 6) !== 0) process.exit(3);
             process.stdout.write("held\\n");
             setInterval(() => {}, 1000);`,
            join(sessions, "killed-session.json.flock"),
        ],
        { stdout: "pipe", stderr: "inherit", env: process.env }
    );
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");
    holder.kill("SIGKILL");
    await holder.exited;

    const exits = await Promise.all(paths.map((filePath) => runHook(editPayload("killed-session", filePath))));

    expect(exits).toEqual(paths.map(() => 0));
    expect((await readJson<{ files: string[] }>("sessions", "killed-session.json")).files.sort()).toEqual(paths.sort());
});

// Regression test: CI 2026-10-08/09, a hook that waited out the 1 s lock deadline exited 1 and its edit was never written.
// PR #480 review t10: a live holder's lock is never taken from it by age, however old the lock file is.
test("a live holder keeps the lock however old it is; the waiting edit is spooled and merged by the next holder", async () => {
    const sessions = join(home, ".genesis-tools", "claude-code", "sessions");
    const lock = join(sessions, "busy-session.json.flock");
    await mkdir(sessions, { recursive: true });
    const release = holdLock(lock);
    await utimes(lock, LONG_AGO, LONG_AGO);

    try {
        expect(
            await runHook(editPayload("busy-session", "/repo/waited.ts"), { GENESIS_TOOLS_SESSION_LOCK_WAIT_MS: "300" })
        ).toBe(0);
        await expect(readJson("sessions", "busy-session.json")).rejects.toThrow();
        expect(await readdir(join(sessions, "busy-session.json.pending"))).toHaveLength(1);
    } finally {
        release();
    }

    expect(await runHook(editPayload("busy-session", "/repo/next.ts"))).toBe(0);
    expect((await readJson<{ files: string[] }>("sessions", "busy-session.json")).files.sort()).toEqual([
        "/repo/next.ts",
        "/repo/waited.ts",
    ]);
    // PR #480 review t12: a merged spool leaves no directory behind.
    await expect(readdir(join(sessions, "busy-session.json.pending"))).rejects.toThrow();
});

// PR #480 review t12: spool directories and lock files used to escape the 30-day retention.
test("retention cleanup drops expired spool entries and idle lock files, and keeps recent or held ones", async () => {
    const sessions = join(home, ".genesis-tools", "claude-code", "sessions");
    const spool = join(sessions, "old-session.json.pending");
    const emptySpool = join(sessions, "empty-session.json.pending");
    await mkdir(spool, { recursive: true });
    await mkdir(emptySpool, { recursive: true });
    await writeFile(join(spool, "expired.json"), JSON.stringify(["/repo/expired.ts"]));
    await utimes(join(spool, "expired.json"), LONG_AGO, LONG_AGO);
    await writeFile(join(spool, "recent.json"), JSON.stringify(["/repo/recent.ts"]));
    for (const name of ["idle-session.json.flock", "held-session.json.flock", "legacy-session.json.lock"]) {
        await writeFile(join(sessions, name), "");
        await utimes(join(sessions, name), LONG_AGO, LONG_AGO);
    }
    const release = holdLock(join(sessions, "held-session.json.flock"));

    try {
        expect(
            await runHook({ session_id: "start", hook_event_name: "SessionStart", transcript_path: CLAUDE_TRANSCRIPT })
        ).toBe(0);
    } finally {
        release();
    }

    const left = await readdir(sessions);
    expect(left).not.toContain("empty-session.json.pending");
    expect(left).not.toContain("idle-session.json.flock");
    expect(left).not.toContain("legacy-session.json.lock");
    expect(left).toContain("held-session.json.flock");
    expect(await readdir(spool)).toEqual(["recent.json"]);
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
