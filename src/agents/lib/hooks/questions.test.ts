import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialogsPath, openQuestions, readSessionQuestions } from "@genesiscz/utils/agents/dialogs/store";
import { SafeJSON } from "@genesiscz/utils/json";
import { hookCaller } from "./caller";
import { DEFAULT_HOOKS_CONFIG, loadHooksConfig } from "./config";
import { installHooks, readSettings, uninstallHooks, wiringStatus } from "./install";
import type { HookPayload } from "./payload";
import { parseHookPayload } from "./payload";
import { applyQuestionHookAction, type QuestionHookAction, questionHookAction } from "./questions";
import { hasOpenDialogRecords, QUESTION_TOOL_MATCHER } from "./questions-gate";
import { applySetting } from "./set-config";

describe("the questions feature", () => {
    it("closes an inherited-session dialog through the hook entrypoint", () => {
        const home = mkdtempSync(join(tmpdir(), "gt-question-entry-"));
        const agents = join(home, ".genesis-tools", "agents");
        mkdirSync(agents, { recursive: true });
        writeFileSync(
            join(agents, "hooks.json"),
            SafeJSON.stringify({ questions: { harnesses: { claude: true }, notify: false } })
        );
        const run = (event: string) =>
            spawnSync(process.execPath, [join(import.meta.dir, "../../bin/hook-question.ts")], {
                input: SafeJSON.stringify({
                    hook_event_name: event,
                    tool_name: "AskUserQuestion",
                    tool_use_id: "q1",
                    tool_input: { questions: [{ question: "Continue?" }] },
                }),
                env: { GENESIS_TOOLS_HOME: home, CLAUDE_CODE_SESSION_ID: "inherited", HOME: home },
                encoding: "utf8",
            });
        expect(run("PreToolUse").status).toBe(0);
        const root = join(agents, "dialogs");
        expect(openQuestions("claude", "inherited", root)).toHaveLength(1);
        expect(run("PostToolUse").status).toBe(0);
        expect(openQuestions("claude", "inherited", root)).toHaveLength(0);
    });

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

    /** The hook's caller as the question hook builds it, here with no inherited env. */
    const callerOf = (payload: HookPayload, env: NodeJS.ProcessEnv = {}) => hookCaller(payload, env);
    const actionOf = (payload: HookPayload, now: string) => questionHookAction(payload, now, callerOf(payload));
    const applyOf = (payload: HookPayload, action: QuestionHookAction, options: { now: string; root?: string }) =>
        applyQuestionHookAction(payload, action, { ...options, caller: callerOf(payload) });

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
        const action = actionOf(ask, now);

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
        expect((await applyOf(ask, action ?? { closes: "none" }, { now, root })).recorded).toBe(
            "claude:s-questions-1:toolu_q1"
        );
        // The same question again (a retried hook) stays one record.
        await applyOf(ask, action ?? { closes: "none" }, { now, root });
        expect(readSessionQuestions("claude", "s-questions-1", root)).toHaveLength(1);

        const answered = claudePayload({
            hook_event_name: "PostToolUse",
            tool_name: "AskUserQuestion",
            tool_use_id: "toolu_q1",
        });
        const result = await applyOf(answered, actionOf(answered, now) ?? { closes: "none" }, {
            now,
            root,
        });

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
        expect(actionOf(plan, "t")?.ask).toMatchObject({ kind: "plan", question: "Approve the plan?" });

        const at = "2026-10-30T19:05:00.000Z";
        const prompt = claudePayload({
            hook_event_name: "Notification",
            notification_type: "permission_prompt",
            message: "Claude needs your permission to use Bash",
        });
        const asked = actionOf(prompt, at);

        expect(asked?.ask).toMatchObject({
            kind: "permission",
            toolCallId: `permission:${at}`,
            question: "Claude needs your permission to use Bash",
        });
        expect(
            actionOf(claudePayload({ hook_event_name: "Notification", notification_type: "idle_prompt" }), at)
        ).toBeNull();

        await applyOf(plan, actionOf(plan, at) ?? { closes: "none" }, { now: at, root });
        await applyOf(prompt, asked ?? { closes: "none" }, { now: at, root });
        expect(openQuestions("claude", "s-questions-1", root)).toHaveLength(2);

        // Any tool's PostToolUse closes the permission prompt, but not the plan still waiting.
        const bash = claudePayload({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_b1" });
        await applyOf(bash, actionOf(bash, at) ?? { closes: "none" }, { now: at, root });
        expect(openQuestions("claude", "s-questions-1", root).map((open) => open.kind)).toEqual(["plan"]);

        // A prompt the user typed closes everything left.
        const typed = claudePayload({ hook_event_name: "UserPromptSubmit", prompt: "go on" });
        await applyOf(typed, actionOf(typed, at) ?? { closes: "none" }, { now: at, root });
        expect(openQuestions("claude", "s-questions-1", root)).toEqual([]);
    });

    it("leaves a question tool without a call id to the watcher, and the gate finds the store's open marker", async () => {
        const noId = claudePayload({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: {} });
        expect(actionOf(noId, "t")).toBeNull();
        expect(actionOf(claudePayload({ hook_event_name: "PreToolUse", tool_name: "Bash" }), "t")).toBeNull();

        const sessionId = "s-gate-1";
        expect(hasOpenDialogRecords("claude", sessionId)).toBe(false);
        const payload = claudePayload({
            session_id: sessionId,
            hook_event_name: "PreToolUse",
            tool_name: "AskUserQuestion",
            tool_use_id: "toolu_g1",
        });
        // The default records root, the one the gate checks without importing the store.
        await applyOf(payload, actionOf(payload, "t") ?? { closes: "none" }, { now: "t" });
        expect(existsSync(dialogsPath("claude", sessionId))).toBe(true);
        expect(hasOpenDialogRecords("claude", sessionId)).toBe(true);
        expect(hasOpenDialogRecords("claude", "../escape")).toBe(false);

        // Answered: the record file stays (it keeps closed records), and the gate stops the hook again.
        const typed = claudePayload({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "go" });
        await applyOf(typed, actionOf(typed, "t2") ?? { closes: "none" }, { now: "t2" });
        expect(existsSync(dialogsPath("claude", sessionId))).toBe(true);
        expect(hasOpenDialogRecords("claude", sessionId)).toBe(false);
    });

    it("a payload that names no session takes the one its hook process inherited from the same harness", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-dialogs-"));
        const payload = parseHookPayload(
            SafeJSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_e1" })
        );

        if (!payload) {
            throw new Error("the fixture payload did not parse");
        }

        const inherited = callerOf(payload, { CLAUDE_CODE_SESSION_ID: "s-env-1" });
        const action = questionHookAction(payload, "t", inherited);
        expect(action?.ask).toMatchObject({ provider: "claude", sessionId: "s-env-1", toolCallId: "toolu_e1" });
        await applyQuestionHookAction(payload, action ?? { closes: "none" }, { now: "t", root, caller: inherited });
        expect(openQuestions("claude", "s-env-1", root)).toHaveLength(1);

        // A Codex session variable describes another harness, so the Claude payload still names no session.
        expect(questionHookAction(payload, "t", callerOf(payload, { CODEX_THREAD_ID: "t-1" }))).toBeNull();
    });
});

describe("the question hook's caller", () => {
    /** A Claude project folder: the main session's transcript and one subagent's own beside it, each with a model. */
    function claudeSession(): { lead: string; subagent: string } {
        const project = join(mkdtempSync(join(tmpdir(), "gt-hook-caller-")), "projects", "-repo");
        const lead = join(project, "s-lead-1.jsonl");
        const subagent = join(project, "s-lead-1", "subagents", "agent-a7.jsonl");
        const row = (model: string) => `${SafeJSON.stringify({ type: "assistant", message: { model } })}\n`;
        mkdirSync(join(project, "s-lead-1", "subagents"), { recursive: true });
        writeFileSync(lead, row("parent-model"));
        writeFileSync(subagent, row("subagent-model"));
        return { lead, subagent };
    }

    function payloadOf(fields: Record<string, unknown>): HookPayload {
        const payload = parseHookPayload(SafeJSON.stringify({ session_id: "s-lead-1", cwd: "/repo", ...fields }));

        if (!payload) {
            throw new Error("the fixture payload did not parse");
        }

        return payload;
    }

    // The hook process of a subagent's call inherits the PARENT's variables: its session, its effort.
    const parentEnv = { CLAUDE_CODE_SESSION_ID: "s-lead-1", CLAUDECODE: "1", CLAUDE_EFFORT: "high" };

    it("a subagent's payload gives the subagent's own id, tool call, transcript and model, not the parent's", () => {
        const { lead, subagent } = claudeSession();
        const caller = hookCaller(
            payloadOf({
                hook_event_name: "PreToolUse",
                tool_name: "AskUserQuestion",
                tool_use_id: "toolu_sub_1",
                agent_id: "a7",
                // Claude names the MAIN session's transcript here, also inside a subagent.
                transcript_path: lead,
            }),
            parentEnv,
            { facets: ["model"] }
        );

        expect(caller).toMatchObject({
            agent: "claude-code",
            sessionId: "s-lead-1",
            subagentId: "a7",
            toolUseId: "toolu_sub_1",
            transcriptPath: subagent,
            model: "subagent-model",
            effort: "high",
        });
        expect(caller.sources).toMatchObject({
            agent: "hook-payload",
            subagentId: "hook-payload",
            toolUseId: "hook-payload",
            transcriptPath: "hook-payload",
            model: "transcript",
            effort: "env",
        });
    });

    it("the main agent's payload keeps the session's own transcript and model", () => {
        const { lead } = claudeSession();
        const caller = hookCaller(
            payloadOf({
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_use_id: "toolu_main",
                transcript_path: lead,
            }),
            parentEnv,
            { facets: ["model"] }
        );

        expect(caller).toMatchObject({ transcriptPath: lead, model: "parent-model", toolUseId: "toolu_main" });
        expect(caller.subagentId).toBeUndefined();
    });

    it("a SubagentStop names the subagent's transcript itself, and the env alone names no subagent", () => {
        const { lead } = claudeSession();
        const stop = payloadOf({
            hook_event_name: "SubagentStop",
            agent_id: "a7",
            transcript_path: lead,
            agent_transcript_path: "/fixture/projects/-repo/s-lead-1/subagents/agent-a7.jsonl",
        });

        expect(hookCaller(stop, parentEnv).transcriptPath).toBe(
            "/fixture/projects/-repo/s-lead-1/subagents/agent-a7.jsonl"
        );
        expect(hookCaller(payloadOf({ hook_event_name: "Stop" }), parentEnv).subagentId).toBeUndefined();
    });
});
