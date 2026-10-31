import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialogsPath, openQuestions, readSessionQuestions } from "@genesiscz/utils/agents/dialogs/store";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_HOOKS_CONFIG, loadHooksConfig } from "./config";
import { installHooks, readSettings, uninstallHooks, wiringStatus } from "./install";
import type { HookPayload } from "./payload";
import { parseHookPayload } from "./payload";
import { applyQuestionHookAction, questionHookAction } from "./questions";
import { hasOpenDialogRecords, QUESTION_TOOL_MATCHER } from "./questions-gate";
import { applySetting } from "./set-config";

describe("the questions feature", () => {
    function settingsFile(body: unknown): string {
        const path = join(mkdtempSync(join(tmpdir(), "gt-hooks-questions-")), "settings.json");
        writeFileSync(path, SafeJSON.stringify(body));
        return path;
    }

    function claudePayload(fields: Record<string, unknown>): HookPayload {
        const payload = parseHookPayload(SafeJSON.stringify({ session_id: "s-questions-1", cwd: "/repo", ...fields }));

        if (!payload) {
            throw new Error("the fixture payload did not parse");
        }

        return payload;
    }

    it("ships off for every harness and is switched per harness or all at once", () => {
        expect(DEFAULT_HOOKS_CONFIG.questions).toEqual({
            harnesses: { claude: false, codex: false, grok: false },
            notify: true,
        });
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "questions", "on").questions.harnesses).toEqual({
            claude: true,
            codex: true,
            grok: true,
        });
        const grok = applySetting(DEFAULT_HOOKS_CONFIG, "questions.grok", "on");
        expect(grok.questions.harnesses).toEqual({ claude: false, codex: false, grok: true });
        expect(applySetting(grok, "questions.harnesses.grok", "false").questions.harnesses.grok).toBe(false);
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "questions.notify", "false").questions.notify).toBe(false);
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "questions.copilot", "on")).toThrow("unknown key");
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "questions", "maybe")).toThrow("true or false");
        // The config it was handed is not changed.
        expect(DEFAULT_HOOKS_CONFIG.questions.harnesses.grok).toBe(false);
    });

    it("reads a stored section field by field and drops a value of the wrong type", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hooks-questions-config-"));
        const path = join(dir, "hooks.json");
        writeFileSync(path, SafeJSON.stringify({ questions: { harnesses: { claude: true, grok: "yes" } } }));

        expect(loadHooksConfig(path).questions).toEqual({
            harnesses: { claude: true, codex: false, grok: false },
            notify: true,
        });
    });

    it("install wires its entries beside the guard's, and off or uninstall removes exactly them", () => {
        const path = settingsFile({
            hooks: { Notification: [{ hooks: [{ type: "command", command: "/theirs.sh" }] }] },
        });
        const options = { dist: "/dist", settingsPath: path, write: true, decisions: false, unpushed: false };
        const on = installHooks({ ...options, questions: true });
        const after = readSettings(path);
        const question = "bun '/dist/src/agents/bin/hook-question.ts'";

        expect(on.added).toEqual(expect.arrayContaining(["Notification", "UserPromptSubmit"]));
        expect(after.hooks?.PreToolUse?.map((entry) => entry.matcher)).toEqual(["Bash", QUESTION_TOOL_MATCHER]);
        expect(after.hooks?.PreToolUse?.[1]?.hooks[0]?.command).toBe(question);
        expect(after.hooks?.PostToolUse?.map((entry) => entry.matcher ?? null)).toEqual([
            "Bash|Edit|MultiEdit|Write",
            null,
        ]);
        expect(after.hooks?.Notification?.map((entry) => entry.matcher ?? null)).toEqual([null, "permission_prompt"]);
        expect(after.hooks?.SessionEnd).toHaveLength(2);
        expect(wiringStatus({ ...options, questions: true }).state).toBe("installed");
        // A second run with nothing to do changes nothing.
        expect(installHooks({ ...options, questions: true }).changed).toBe(false);

        const off = installHooks({ ...options, questions: false });
        const plain = readSettings(path);

        expect(off.removed).toEqual(expect.arrayContaining(["Notification", "UserPromptSubmit"]));
        expect(plain.hooks?.PreToolUse?.map((entry) => entry.matcher)).toEqual(["Bash"]);
        expect(plain.hooks?.Notification).toEqual([{ hooks: [{ type: "command", command: "/theirs.sh" }] }]);
        expect(SafeJSON.stringify(plain)).not.toContain("hook-question.ts");

        installHooks({ ...options, questions: true });
        uninstallHooks({ settingsPath: path, write: true });
        const gone = readSettings(path);

        expect(SafeJSON.stringify(gone)).not.toContain("src/agents/bin/hook-");
        expect(gone.hooks?.Notification).toEqual([{ hooks: [{ type: "command", command: "/theirs.sh" }] }]);
    });

    it("records AskUserQuestion with its options, and its PostToolUse answers it", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-dialogs-"));
        const now = "2026-10-30T19:00:00.000Z";
        const ask = claudePayload({
            hook_event_name: "PreToolUse",
            tool_name: "AskUserQuestion",
            tool_use_id: "toolu_q1",
            tool_input: { questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }] },
        });
        const action = questionHookAction(ask, now);

        expect(action?.ask).toEqual({
            provider: "claude",
            sessionId: "s-questions-1",
            toolCallId: "toolu_q1",
            kind: "decision",
            question: "Ship it?",
            options: ["Yes", "No"],
            questionCount: 1,
            askedAt: now,
            source: "hook",
        });
        expect((await applyQuestionHookAction(ask, action ?? { closes: "none" }, { now, root })).recorded).toBe(
            "claude:s-questions-1:toolu_q1"
        );
        // The same question again (a retried hook) stays one record.
        await applyQuestionHookAction(ask, action ?? { closes: "none" }, { now, root });
        expect(readSessionQuestions("claude", "s-questions-1", root)).toHaveLength(1);

        const answered = claudePayload({
            hook_event_name: "PostToolUse",
            tool_name: "AskUserQuestion",
            tool_use_id: "toolu_q1",
        });
        const result = await applyQuestionHookAction(
            answered,
            questionHookAction(answered, now) ?? { closes: "none" },
            {
                now,
                root,
            }
        );

        expect(result.closed).toEqual(["claude:s-questions-1:toolu_q1"]);
        expect(openQuestions("claude", "s-questions-1", root)).toEqual([]);
    });

    it("records ExitPlanMode as a plan and a permission notification as a permission, closed by the next tool", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-dialogs-"));
        const plan = claudePayload({
            hook_event_name: "PreToolUse",
            tool_name: "ExitPlanMode",
            tool_use_id: "toolu_p1",
            tool_input: { plan: "1. do it" },
        });
        expect(questionHookAction(plan, "t")?.ask).toMatchObject({ kind: "plan", question: "Approve the plan?" });

        const at = "2026-10-30T19:05:00.000Z";
        const prompt = claudePayload({
            hook_event_name: "Notification",
            notification_type: "permission_prompt",
            message: "Claude needs your permission to use Bash",
        });
        const asked = questionHookAction(prompt, at);

        expect(asked?.ask).toMatchObject({
            kind: "permission",
            toolCallId: `permission:${at}`,
            question: "Claude needs your permission to use Bash",
        });
        expect(
            questionHookAction(claudePayload({ hook_event_name: "Notification", notification_type: "idle_prompt" }), at)
        ).toBeNull();

        await applyQuestionHookAction(plan, questionHookAction(plan, at) ?? { closes: "none" }, { now: at, root });
        await applyQuestionHookAction(prompt, asked ?? { closes: "none" }, { now: at, root });
        expect(openQuestions("claude", "s-questions-1", root)).toHaveLength(2);

        // Any tool's PostToolUse closes the permission prompt, but not the plan still waiting.
        const bash = claudePayload({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_b1" });
        await applyQuestionHookAction(bash, questionHookAction(bash, at) ?? { closes: "none" }, { now: at, root });
        expect(openQuestions("claude", "s-questions-1", root).map((open) => open.kind)).toEqual(["plan"]);

        // A prompt the user typed closes everything left.
        const typed = claudePayload({ hook_event_name: "UserPromptSubmit", prompt: "go on" });
        await applyQuestionHookAction(typed, questionHookAction(typed, at) ?? { closes: "none" }, { now: at, root });
        expect(openQuestions("claude", "s-questions-1", root)).toEqual([]);
    });

    it("leaves a question tool without a call id to the watcher, and the gate finds the store's open marker", async () => {
        const noId = claudePayload({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: {} });
        expect(questionHookAction(noId, "t")).toBeNull();
        expect(questionHookAction(claudePayload({ hook_event_name: "PreToolUse", tool_name: "Bash" }), "t")).toBeNull();

        const sessionId = "s-gate-1";
        expect(hasOpenDialogRecords("claude", sessionId)).toBe(false);
        const payload = claudePayload({
            session_id: sessionId,
            hook_event_name: "PreToolUse",
            tool_name: "AskUserQuestion",
            tool_use_id: "toolu_g1",
        });
        // The default records root, the one the gate checks without importing the store.
        await applyQuestionHookAction(payload, questionHookAction(payload, "t") ?? { closes: "none" }, { now: "t" });
        expect(existsSync(dialogsPath("claude", sessionId))).toBe(true);
        expect(hasOpenDialogRecords("claude", sessionId)).toBe(true);
        expect(hasOpenDialogRecords("claude", "../escape")).toBe(false);

        // Answered: the record file stays (it keeps closed records), and the gate stops the hook again.
        const typed = claudePayload({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "go" });
        await applyQuestionHookAction(typed, questionHookAction(typed, "t2") ?? { closes: "none" }, { now: "t2" });
        expect(existsSync(dialogsPath("claude", sessionId))).toBe(true);
        expect(hasOpenDialogRecords("claude", sessionId)).toBe(false);
    });
});
