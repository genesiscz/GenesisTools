import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CLAUDE_REMINDER,
    CODEX_REMINDER,
    GROK_REMINDER,
    harnessOf,
    hintEnabled,
    reminderFor,
} from "./agents-talk-hint";

const HOOK = join(import.meta.dir, "agents-talk-hint.ts");

/** A home with no hooks.json, so the real `~/.genesis-tools/agents/hooks.json` never decides a test. */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "agents-talk-hint-"));

function homeWithHint(hint: boolean): string {
    const home = mkdtempSync(join(tmpdir(), "agents-talk-hint-"));
    mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "agents", "hooks.json"), JSON.stringify({ agentsTalk: { hint } }));
    return home;
}

async function runHook(
    stdin: string,
    home = EMPTY_HOME
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", HOOK], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GENESIS_TOOLS_HOME: home },
    });
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
            JSON.stringify({
                session_id: "s",
                transcript_path: "/Users/u/.claude/projects/-Users-u-repo/s.jsonl",
                hook_event_name: "SessionStart",
            })
        );
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
        expect(parsed.hookSpecificOutput.additionalContext).toBe(CLAUDE_REMINDER);
        expect(CLAUDE_REMINDER).toContain("gt:handoff-to");
        expect(CLAUDE_REMINDER).toMatch(/agent team/);
        expect(CLAUDE_REMINDER).not.toMatch(/before spawning subagents/i);
    });

    test("agentsTalk.hint false in hooks.json silences the hook; true and no file keep it", async () => {
        const payload = JSON.stringify({ transcript_path: "/Users/u/.claude/projects/-r/s.jsonl" });
        const off = await runHook(payload, homeWithHint(false));
        const on = await runHook(payload, homeWithHint(true));

        expect(off.exitCode).toBe(0);
        expect(off.stdout).toBe("");
        expect(JSON.parse(on.stdout).hookSpecificOutput.additionalContext).toBe(CLAUDE_REMINDER);
        expect(hintEnabled(join(EMPTY_HOME, "missing.json"))).toBe(true);

        // A hand-edited file with a comment and a trailing comma, which the main loader accepts too.
        const commented = join(mkdtempSync(join(tmpdir(), "agents-talk-hint-")), "hooks.json");
        writeFileSync(commented, `{\n    // switched off by hand\n    "agentsTalk": { "hint": false },\n}\n`);
        expect(hintEnabled(commented)).toBe(false);
    });

    test("Codex is told never to invoke the skill and what to use instead", async () => {
        const result = await runHook(
            JSON.stringify({
                session_id: "01a0",
                transcript_path: "/Users/u/.codex-personal/sessions/2026/09/09/rollout-2026-09-09T16-51-21-01a0.jsonl",
                hook_event_name: "SessionStart",
                model: "gpt-6-astra",
            })
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe(CODEX_REMINDER);
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

// Regression test: Grok's hook stdin names the transcript transcriptPath. Reading only transcript_path classified it as Claude.
test("a transcriptPath under a grok home selects the grok reminder", () => {
    const payload = { transcriptPath: "/Users/u/.grok/sessions/chat.jsonl" };

    expect(harnessOf(payload)).toBe("grok");
    expect(reminderFor(payload)).toBe(GROK_REMINDER);
});

test("grok is sent to the skill's Grok section, with grok's own push monitor", () => {
    // Grok 1.0.44 has a push `monitor` tool ("notifications arrive in the chat"), checked
    // against a live session's tool_definitions.json on 2026-10-01. The old text banned the
    // skill because it assumed grok could only poll. Its route is still not Codex's send_message.
    const payload = { transcript_path: "/Users/u/.grok/sessions/%2Frepo/019ffbbd-80e9-79f1-a619-2c8d52bb5377.jsonl" };

    expect(harnessOf(payload)).toBe("grok");
    expect(reminderFor(payload)).toBe(GROK_REMINDER);
    expect(GROK_REMINDER).not.toMatch(/never invoke/i);
    expect(GROK_REMINDER).toContain("`monitor`");
    expect(GROK_REMINDER).toContain("--session");
    expect(GROK_REMINDER).toContain("resume_from");
    expect(GROK_REMINDER).not.toContain("send_message");
});
