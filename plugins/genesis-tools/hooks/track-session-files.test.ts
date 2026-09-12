import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * All three harnesses run this hook, and they name their edit tools differently. The matcher
 * in `hooks.json` only narrows Claude's calls; Codex and Grok deliver every tool call, so an
 * unrecognised name must be tallied rather than silently dropped — that tally is how the
 * candidate names in `EDIT_TOOLS` get confirmed instead of guessed at forever.
 */

const HOOK = join(import.meta.dir, "track-session-files.ts");
let home: string;

async function runHook(payload: unknown): Promise<number> {
    const proc = Bun.spawn(["bun", HOOK], {
        stdin: new TextEncoder().encode(SafeJSON.stringify(payload)),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GENESIS_TOOLS_HOME: home },
    });

    return await proc.exited;
}

async function readJson<T>(...segments: string[]): Promise<T> {
    return SafeJSON.parse(await readFile(join(home, ".genesis-tools", "claude-code", ...segments), "utf8")) as T;
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
