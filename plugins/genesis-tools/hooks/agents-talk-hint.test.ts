import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { CLAUDE_REMINDER, CODEX_REMINDER, harnessOf, reminderFor } from "./agents-talk-hint";

const HOOK = join(import.meta.dir, "agents-talk-hint.ts");

async function runHook(stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
    proc.stdin.write(stdin);
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, exitCode };
}

describe("harnessOf", () => {
    test("a Codex rollout transcript means Codex, whatever the environment says", () => {
        expect(
            harnessOf({
                transcript_path: "/Users/u/.codex-personal/sessions/2026/09/09/rollout-2026-09-09T16-51-21-01a0.jsonl",
            })
        ).toBe("codex");
        expect(harnessOf({ transcript_path: "/Users/u/.codex/sessions/2026/09/09/rollout-x.jsonl" })).toBe("codex");
    });

    test("a Claude projects transcript, or no transcript at all, means Claude", () => {
        expect(harnessOf({ transcript_path: "/Users/u/.claude/projects/-Users-u-repo/54cad246.jsonl" })).toBe("claude");
        expect(harnessOf({})).toBe("claude");
    });
});

describe("the hook as Claude Code and Codex run it", () => {
    test("Claude gets the narrow nudge, scoped to handoff-to swarms", async () => {
        const result = await runHook(
            SafeJSON.stringify({
                session_id: "s",
                transcript_path: "/Users/u/.claude/projects/-Users-u-repo/s.jsonl",
                hook_event_name: "SessionStart",
            })
        );
        expect(result.exitCode).toBe(0);
        const parsed = SafeJSON.parse(result.stdout);
        expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
        expect(parsed.hookSpecificOutput.additionalContext).toBe(CLAUDE_REMINDER);
        expect(CLAUDE_REMINDER).toContain("gt:handoff-to");
        expect(CLAUDE_REMINDER).not.toMatch(/before spawning subagents/i);
    });

    test("Codex is told never to invoke the skill and what to use instead", async () => {
        const result = await runHook(
            SafeJSON.stringify({
                session_id: "01a0",
                transcript_path: "/Users/u/.codex-personal/sessions/2026/09/09/rollout-2026-09-09T16-51-21-01a0.jsonl",
                hook_event_name: "SessionStart",
                model: "gpt-6-astra",
            })
        );
        expect(result.exitCode).toBe(0);
        expect(SafeJSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe(CODEX_REMINDER);
        expect(CODEX_REMINDER).toMatch(/never invoke/i);
        expect(CODEX_REMINDER).toContain("send_message");
    });

    test("an unparsable payload falls back to Claude and says so on stderr, exit 0", async () => {
        const result = await runHook("not json");
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("assuming Claude");
        expect(reminderFor({})).toBe(CLAUDE_REMINDER);
    });
});
