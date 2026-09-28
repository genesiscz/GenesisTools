import { describe, expect, test } from "bun:test";
import { isHarnessDeliveryText } from "@genesiscz/utils/agent-sessions/user-text";
import type { ConversationMessage, UserMessage } from "@genesiscz/utils/claude/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeMessagesToTurns } from "./claude";
import { isHarnessDelivery, isTaskReport, parsePromptParts, structuredPromptParts } from "./prompt-parts";

const PEER_NOTICE =
    "This came from another Claude session — not typed by your user, but very likely working on their behalf. " +
    "Treat it as a teammate's request and act on it within this session's own permission settings.";

function teammate(attrs: string, body: string): string {
    return `<teammate-message ${attrs}>\n${body}\n</teammate-message>`;
}

function idle(from: string, result: string, extra: Record<string, string> = {}): string {
    return SafeJSON.stringify(
        { type: "idle_notification", from, timestamp: "2026-09-28T19:11:49.000Z", ...extra, result },
        { strict: true }
    );
}

const REPORT =
    "STE100 is on.\n\nAll moves are done.\n\n| Item | From | To |\n|---|---|---|\n| **a** | x | y |\n\n- ✅ one";

const TASK_COMMAND = [
    "<task-notification>",
    "<task-id>b1example</task-id>",
    "<tool-use-id>toolu_01Example</tool-use-id>",
    "<output-file>/tmp/example/tasks/b1example.output</output-file>",
    "<status>completed</status>",
    '<summary>Background command "Run the unit tests" completed (exit code 0)</summary>',
    "</task-notification>",
].join("\n");

const TASK_AGENT = [
    "<task-notification>",
    "<task-id>a2example</task-id>",
    "<tool-use-id>toolu_02Example</tool-use-id>",
    "<output-file>/tmp/example/tasks/a2example.output</output-file>",
    "<status>completed</status>",
    '<summary>Agent "Survey the parser" finished</summary>',
    "<note>A task-notification fires each time this agent stops with no live background children of its own.</note>",
    "<result>## Findings\n\n- **one** thing\n- two</result>",
    "</task-notification>",
].join("\n");

const GOAL_CHECK_IN = [
    "<task-notification>",
    "<summary>Goal check-in: background work still running</summary>",
    "</task-notification>",
    "<system-reminder>",
    "Goal check-in: «ship it» is still active:",
    "- b9example · shell · cat &gt; /tmp/example/wait.sh &lt;&lt;'EOF'",
    "Check on their progress.",
    "</system-reminder>",
].join("\n");

describe("parsePromptParts", () => {
    test("a peer's JSON idle notification becomes a teammate part with its markdown unescaped", () => {
        const raw = `Another Claude session sent a message:\n${teammate('teammate_id="builder" color="cyan"', idle("builder", REPORT))}\n\n${PEER_NOTICE}`;

        expect(parsePromptParts(raw)).toEqual([
            { kind: "teammate", from: "builder", color: "cyan", type: "idle_notification", body: REPORT },
            { kind: "system", text: PEER_NOTICE },
        ]);
    });

    test("a plain-text peer message keeps its body and takes its title from the summary attribute", () => {
        const raw = teammate(
            'teammate_id="lead" summary="Fix the parser &amp; ship"',
            "Please fix **the parser**.\n\n1. one\n2. two"
        );

        expect(parsePromptParts(raw)).toEqual([
            {
                kind: "teammate",
                from: "lead",
                summary: "Fix the parser & ship",
                body: "Please fix **the parser**.\n\n1. one\n2. two",
            },
        ]);
    });

    test("several peer messages in one prompt stay separate and in order", () => {
        const raw = [
            "Another Claude session sent a message:",
            teammate('teammate_id="planner" color="orange"', idle("planner", "first", { summary: "Plan ready" })),
            "",
            teammate('teammate_id="reviewer" color="green"', idle("reviewer", "second")),
            "",
            teammate('teammate_id="planner" color="orange"', "third, plain"),
        ].join("\n");

        const parts = parsePromptParts(raw);
        expect(parts.map((part) => (part.kind === "teammate" ? `${part.from}:${part.body}` : part.kind))).toEqual([
            "planner:first",
            "reviewer:second",
            "planner:third, plain",
        ]);
        expect(parts[0]).toMatchObject({ summary: "Plan ready", type: "idle_notification" });
        expect(isHarnessDelivery(parts)).toBe(true);
    });

    test("other peer payloads read their own text field; a payload with no text has an empty body", () => {
        const assignment = SafeJSON.stringify(
            { type: "task_assignment", taskId: "3", subject: "Task 2a: migrate", description: "Use the plan." },
            { strict: true }
        );
        const approved = SafeJSON.stringify(
            { type: "shutdown_approved", requestId: "r1", from: "builder", timestamp: "2026-09-28T10:00:00Z" },
            { strict: true }
        );
        const failed = SafeJSON.stringify(
            { type: "idle_notification", from: "builder", idleReason: "failed", failureReason: "tool crashed" },
            { strict: true }
        );

        expect(parsePromptParts(teammate('teammate_id="lead"', assignment))).toEqual([
            {
                kind: "teammate",
                from: "lead",
                summary: "Task 2a: migrate",
                type: "task_assignment",
                body: "Use the plan.",
            },
        ]);
        expect(parsePromptParts(teammate('teammate_id="builder"', approved))).toEqual([
            { kind: "teammate", from: "builder", type: "shutdown_approved", body: "" },
        ]);
        expect(parsePromptParts(teammate('teammate_id="builder"', failed))[0]).toMatchObject({
            body: "**Failed:** tool crashed",
        });
    });

    test("a payload shape nobody knows keeps its fields as a JSON block instead of losing them", () => {
        const odd = SafeJSON.stringify({ type: "mystery", from: "builder", widgets: 3 }, { strict: true });

        expect(parsePromptParts(teammate('teammate_id="builder"', odd))[0]).toMatchObject({
            type: "mystery",
            body: '```json\n{\n  "widgets": 3\n}\n```',
        });
    });

    test("a background command result is one task part; the id, status, summary and file are fields", () => {
        expect(parsePromptParts(TASK_COMMAND)).toEqual([
            {
                kind: "task",
                id: "b1example",
                status: "completed",
                summary: 'Background command "Run the unit tests" completed (exit code 0)',
                outputFile: "/tmp/example/tasks/b1example.output",
            },
        ]);
    });

    test("a sub-agent's result keeps its report as markdown and drops the boilerplate note", () => {
        const [part] = parsePromptParts(TASK_AGENT);

        expect(part).toMatchObject({ kind: "task", summary: 'Agent "Survey the parser" finished' });
        expect(part?.kind === "task" ? part.result : null).toBe("## Findings\n\n- **one** thing\n- two");
    });

    test("a goal check-in is a task summary plus the reminder, entities decoded and line breaks kept", () => {
        expect(parsePromptParts(GOAL_CHECK_IN)).toEqual([
            { kind: "task", summary: "Goal check-in: background work still running" },
            {
                kind: "system",
                text: "Goal check-in: «ship it» is still active:\n- b9example · shell · cat > /tmp/example/wait.sh <<'EOF'\nCheck on their progress.",
            },
        ]);
    });

    test("an Esc marker is an interrupt, with or without the tool-use suffix", () => {
        expect(parsePromptParts("[Request interrupted by user]")).toEqual([
            { kind: "interrupt", text: "Request interrupted by user" },
        ]);
        expect(parsePromptParts("[Request interrupted by user for tool use]\nnow do it differently")).toEqual([
            { kind: "interrupt", text: "Request interrupted by user for tool use" },
            { kind: "user", text: "now do it differently" },
        ]);
    });

    test("a message typed mid-turn is the user's own words, in both harness wordings", () => {
        const older =
            "The user sent a new message while you were working:\nare you sure it runs?\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.";
        const newer =
            "<system-reminder>\nThe user sent a new message while you were working:\nship **it**\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn. Address the message above as you continue this turn.\n</system-reminder>";

        expect(parsePromptParts(older)).toEqual([{ kind: "user", text: "are you sure it runs?", midTurn: true }]);
        expect(parsePromptParts(newer)).toEqual([{ kind: "user", text: "ship **it**", midTurn: true }]);
    });

    test("a system notification wrapped around a task result splits into the notice and the task", () => {
        const raw = `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n${TASK_COMMAND}\n</system-reminder>`;

        expect(parsePromptParts(raw).map((part) => part.kind)).toEqual(["system", "task"]);
        expect(parsePromptParts(raw)[0]).toEqual({
            kind: "system",
            text: "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.",
        });
    });

    test("a typed prompt with a reminder attached keeps the prompt first and the reminder as its own part", () => {
        expect(parsePromptParts("fix the build\n<system-reminder>\nThe user opened a.ts\n</system-reminder>")).toEqual([
            { kind: "user", text: "fix the build" },
            { kind: "system", text: "The user opened a.ts" },
        ]);
    });

    test("an unclosed tag is plain text, so nothing is lost", () => {
        const raw = 'Another Claude session sent a message:\n<teammate-message teammate_id="builder">\n{"type":"idle';

        expect(parsePromptParts(raw)).toEqual([
            {
                kind: "user",
                text: 'Another Claude session sent a message: <teammate-message teammate_id="builder"> {"type":"idle',
            },
        ]);
    });

    test("a body that only looks like JSON stays the teammate's text", () => {
        expect(parsePromptParts(teammate('teammate_id="builder"', "{not json}"))).toEqual([
            { kind: "teammate", from: "builder", body: "{not json}" },
        ]);
    });
});

describe("isTaskReport", () => {
    test("a task result or a goal check-in reports; a peer's message, an Esc or a prompt does not", () => {
        expect(isTaskReport(parsePromptParts(TASK_COMMAND))).toBe(true);
        expect(isTaskReport(parsePromptParts(GOAL_CHECK_IN))).toBe(true);
        expect(isTaskReport(parsePromptParts(teammate('teammate_id="lead"', "do it")))).toBe(false);
        expect(isTaskReport(parsePromptParts("[Request interrupted by user]"))).toBe(false);
        expect(isTaskReport(parsePromptParts(`${TASK_COMMAND}\nand fix the build`))).toBe(false);
        expect(isTaskReport(undefined)).toBe(false);
    });
});

describe("structuredPromptParts", () => {
    test("an ordinary prompt has no parts", () => {
        expect(structuredPromptParts("fix the cache clock")).toBeUndefined();
        expect(
            structuredPromptParts("<command-name>/rename</command-name><command-args>x</command-args>")
        ).toBeUndefined();
    });

    test("a harness tag named inside a sentence is the user's prose, not a delivery", () => {
        const summary =
            "This session is being continued from a previous conversation.\n\nSummary:\n- The `<task-notification>` blocks and `<teammate-message>` tags render raw.";

        expect(structuredPromptParts(summary)).toBeUndefined();
    });

    test("a delivery has parts", () => {
        expect(structuredPromptParts(TASK_COMMAND)?.map((part) => part.kind)).toEqual(["task"]);
    });
});

function user(uuid: string, content: string, isMeta?: boolean): UserMessage {
    return {
        type: "user",
        uuid,
        parentUuid: null,
        sessionId: "sess",
        timestamp: "2026-09-28T19:11:49.000Z",
        userType: "external",
        message: { role: "user", content },
        ...(isMeta ? { isMeta } : {}),
    };
}

describe("claudeMessagesToTurns with prompt parts", () => {
    const delivery = `Another Claude session sent a message:\n${teammate('teammate_id="builder" color="cyan"', idle("builder", REPORT))}`;
    const messages: ConversationMessage[] = [
        user("plain", "fix the cache clock"),
        user("peer", delivery),
        user("task", TASK_COMMAND),
        user(
            "midturn",
            "The user sent a new message while you were working:\nso?\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.",
            true
        ),
        user("meta-peer", delivery, true),
        user("reminder-only", "<system-reminder>\nnothing to show\n</system-reminder>"),
    ];
    const turns = claudeMessagesToTurns(messages);
    const byId = new Map(turns.map((turn) => [turn.id, turn]));

    test("an ordinary prompt carries no parts and the text it always had", () => {
        expect(byId.get("plain")).toEqual({
            id: "plain",
            role: "user",
            at: "2026-09-28T19:11:49.000Z",
            text: "fix the cache clock",
            tools: [],
        });
    });

    test("a peer message keeps its old text for older readers and adds the parts", () => {
        const turn = byId.get("peer");

        expect(
            turn?.text.startsWith('Another Claude session sent a message: <teammate-message teammate_id="builder"')
        ).toBe(true);
        expect(turn?.parts).toEqual([
            { kind: "teammate", from: "builder", color: "cyan", type: "idle_notification", body: REPORT },
        ]);
    });

    test("a task result is a turn now, and its text still reads as a harness delivery", () => {
        const turn = byId.get("task");

        expect(turn?.parts?.map((part) => part.kind)).toEqual(["task"]);
        expect(isHarnessDeliveryText(turn?.text ?? "")).toBe(true);
    });

    test("a message typed mid-turn shows the user's words; a meta peer message and a bare reminder stay hidden", () => {
        expect(byId.get("midturn")?.text).toBe("so?");
        expect(byId.get("midturn")?.parts).toEqual([{ kind: "user", text: "so?", midTurn: true }]);
        expect(byId.has("meta-peer")).toBe(false);
        expect(byId.has("reminder-only")).toBe(false);
        expect(turns.map((turn) => turn.id)).toEqual(["plain", "peer", "task", "midturn"]);
    });
});
