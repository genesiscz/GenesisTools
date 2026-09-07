import { describe, expect, test } from "bun:test";
import { isApprovalRequest, isText, isToolCall, isToolResult, isUsageLimits } from "@genesiscz/utils/worker/events";
import { formatStoredEventLine, type StoredCodexEvent, toWorkerEvent } from "./adapter";

// Shapes captured from real session logs under ~/.genesis-tools/codex/sessions
// (2026-09-01); payload text and paths replaced with fixture values.
const THREAD = "01a0437d-0000-7c51-86f0-000000000001";

const agentMessageDelta: StoredCodexEvent = {
    source: "app-server",
    method: "item/agentMessage/delta",
    params: { threadId: THREAD, turnId: "t1", itemId: "msg_1", delta: "I" },
    ts: "2026-09-01T00:00:00.000Z",
};

const agentMessageCompleted: StoredCodexEvent = {
    source: "app-server",
    method: "item/completed",
    params: {
        threadId: THREAD,
        item: { type: "agentMessage", id: "msg_1", text: "The review is done." },
    },
};

const reasoningCompleted: StoredCodexEvent = {
    source: "app-server",
    method: "item/completed",
    params: {
        threadId: THREAD,
        item: { type: "reasoning", id: "rs_1", summary: [], content: [{ type: "text", text: "thinking…" }] },
    },
};

const commandStarted: StoredCodexEvent = {
    source: "app-server",
    method: "item/started",
    params: {
        threadId: THREAD,
        item: {
            type: "commandExecution",
            id: "exec-1",
            command: '/bin/zsh -lc "bun run test"',
            status: "inProgress",
            exitCode: null,
            aggregatedOutput: null,
        },
    },
};

const commandCompleted: StoredCodexEvent = {
    source: "app-server",
    method: "item/completed",
    params: {
        threadId: THREAD,
        item: {
            type: "commandExecution",
            id: "exec-1",
            command: '/bin/zsh -lc "bun run test"',
            status: "completed",
            exitCode: 0,
            aggregatedOutput: "2 pass",
        },
    },
};

const COMPLETED_ITEM = {
    type: "commandExecution",
    id: "exec-1",
    command: '/bin/zsh -lc "bun run test"',
    status: "completed",
    exitCode: 0 as number | undefined,
    aggregatedOutput: "2 pass",
};

function completedWith(item: Record<string, unknown>): StoredCodexEvent {
    return { source: "app-server", method: "item/completed", params: { threadId: THREAD, item } };
}

const fileChangeStarted: StoredCodexEvent = {
    source: "app-server",
    method: "item/started",
    params: {
        threadId: THREAD,
        item: { type: "fileChange", id: "exec-2", changes: [{ path: "/tmp/example/note.md", kind: { type: "add" } }] },
    },
};

const turnStarted: StoredCodexEvent = {
    source: "app-server",
    method: "turn/started",
    params: { threadId: THREAD, turn: { id: "turn-1", status: "inProgress" } },
};

const turnCompleted: StoredCodexEvent = {
    source: "app-server",
    method: "turn/completed",
    params: { threadId: THREAD, turn: { id: "turn-1", status: "completed", error: null } },
};

const turnInterrupted: StoredCodexEvent = {
    source: "app-server",
    method: "turn/completed",
    params: { threadId: THREAD, turn: { id: "turn-1", status: "failed", error: "interrupted" } },
};

const approvalRequest: StoredCodexEvent = {
    source: "daemon",
    method: "approval_request",
    params: {
        event: "approval_request",
        op: "approval_request",
        requestId: "42",
        method: "item/commandExecution/requestApproval",
        detail: "rm -rf node_modules",
    },
};

describe("formatStoredEventLine", () => {
    test("prints the completed message once and drops the deltas that repeat it", () => {
        // `--events` used to print a line per token and then the whole message
        // again, because both map to a `text` event.
        expect(formatStoredEventLine(agentMessageDelta)).toBe("");
        expect(formatStoredEventLine(agentMessageCompleted)).toContain("The review is done.");
    });
});

describe("codex toWorkerEvent", () => {
    test("agent message delta becomes a text delta", () => {
        const event = toWorkerEvent(agentMessageDelta);
        expect(event).not.toBeNull();
        expect(isText(event!)).toBe(true);
        expect(event).toMatchObject({ kind: "text", sessionId: THREAD, text: "I", delta: true });
    });

    test("completed agent message becomes a whole text event", () => {
        expect(toWorkerEvent(agentMessageCompleted)).toMatchObject({
            kind: "text",
            text: "The review is done.",
            delta: false,
        });
    });

    test("completed reasoning carries its content text", () => {
        expect(toWorkerEvent(reasoningCompleted)).toMatchObject({ kind: "reasoning", text: "thinking…" });
    });

    test("command execution maps to tool_call then tool_result", () => {
        const call = toWorkerEvent(commandStarted);
        expect(isToolCall(call!)).toBe(true);
        expect(call).toMatchObject({ tool: "command", target: '/bin/zsh -lc "bun run test"', callId: "exec-1" });

        const result = toWorkerEvent(commandCompleted);
        expect(isToolResult(result!)).toBe(true);
        expect(result).toMatchObject({ callId: "exec-1", ok: true, output: "2 pass" });
    });

    test("a completed command with no exitCode falls back to its status, not to failure", () => {
        // `exitCode` is typed `number | null` but omitted in practice on a
        // cancelled or still-settling command, and `undefined === 0` rendered
        // "↩ command FAILED" for a command that did not fail.
        const { exitCode: _dropped, ...item } = COMPLETED_ITEM;

        expect(toWorkerEvent(completedWith(item))).toMatchObject({ callId: "exec-1", ok: true });
        expect(toWorkerEvent(completedWith({ ...item, status: "failed" }))).toMatchObject({
            callId: "exec-1",
            ok: false,
        });
    });

    test("a real non-zero exit is still a failure", () => {
        expect(toWorkerEvent(completedWith({ ...COMPLETED_ITEM, exitCode: 1 }))).toMatchObject({
            callId: "exec-1",
            ok: false,
        });
    });

    test("file change start maps to a tool_call naming the paths", () => {
        expect(toWorkerEvent(fileChangeStarted)).toMatchObject({
            kind: "tool_call",
            tool: "file_change",
            target: "/tmp/example/note.md",
        });
    });

    test("turn lifecycle maps, and an interrupted turn is a failure", () => {
        expect(toWorkerEvent(turnStarted)).toMatchObject({ kind: "turn.started", sessionId: THREAD });
        expect(toWorkerEvent(turnCompleted)).toMatchObject({ kind: "turn.completed" });
        expect(toWorkerEvent(turnInterrupted)).toMatchObject({ kind: "turn.failed", reason: "interrupted" });
    });

    test("a daemon approval_request keeps the request id tools codex approve needs", () => {
        const event = toWorkerEvent(approvalRequest);
        expect(isApprovalRequest(event!)).toBe(true);
        expect(event).toMatchObject({ requestId: "42", detail: "rm -rf node_modules" });
    });

    test("bookkeeping chatter stays out of the shared stream", () => {
        for (const method of [
            "mcpServer/startupStatus/updated",
            "hook/started",
            "hook/completed",
            "thread/tokenUsage/updated",
            "item/commandExecution/outputDelta",
            "daemon/started",
        ]) {
            expect(toWorkerEvent({ source: "app-server", method, params: { threadId: THREAD } })).toBeNull();
        }
    });

    // A live push the daemon used to drop. Field names captured from a real
    // `account/rateLimits/read` on 2026-09-04: rateLimits.{primary,secondary}
    // carry usedPercent / windowDurationMins / resetsAt (epoch SECONDS).
    test("account/rateLimits/updated becomes a usage.limits event carrying the raw payload", () => {
        const params = {
            threadId: THREAD,
            rateLimits: {
                primary: { usedPercent: 41.5, windowDurationMins: 300, resetsAt: 1_757_000_000 },
                secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_757_400_000 },
                planType: "plus",
            },
        };

        const event = toWorkerEvent({ source: "app-server", method: "account/rateLimits/updated", params });

        expect(event).toMatchObject({ kind: "usage.limits", sessionId: THREAD });
        expect(isUsageLimits(event!)).toBe(true);
        expect((event as { native: typeof params }).native).toBe(params);
    });

    test("user messages are not re-emitted", () => {
        expect(
            toWorkerEvent({
                source: "app-server",
                method: "item/completed",
                params: { threadId: THREAD, item: { type: "userMessage", id: "u1" } },
            })
        ).toBeNull();
    });
});
