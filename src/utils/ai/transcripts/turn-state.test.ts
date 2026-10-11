import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    claudeTurnState,
    codexTurnState,
    grokTurnState,
    liveActivityOf,
    readTurnState,
    type TurnStateInput,
    toolSummaryOf,
} from "./turn-state";

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const iso = (offsetSec: number): string => new Date(T0 + offsetSec * 1000).toISOString();

function input(records: Record<string, unknown>[], nowOffsetSec: number, stallSec = 900): TurnStateInput {
    return { records, lastModified: T0, now: T0 + nowOffsetSec * 1000, stallTimeoutMs: stallSec * 1000 };
}

function claudeUser(sec: number, content: unknown = "do it"): Record<string, unknown> {
    return { type: "user", timestamp: iso(sec), message: { role: "user", content } };
}

function claudeAssistant(
    sec: number,
    blocks: unknown[],
    stopReason: string | null,
    id = "msg_1"
): Record<string, unknown> {
    return {
        type: "assistant",
        timestamp: iso(sec),
        message: { id, role: "assistant", content: blocks, stop_reason: stopReason },
    };
}

describe("claudeTurnState", () => {
    it("is RUNNING while the last record is a tool call", () => {
        const snap = claudeTurnState(
            input([claudeUser(0), claudeAssistant(5, [{ type: "tool_use", name: "Bash", input: {} }], "tool_use")], 10)
        );

        expect(snap.state).toBe("RUNNING");
    });

    it("ends the turn on end_turn and returns the whole last message across its records", () => {
        const snap = claudeTurnState(
            input(
                [
                    claudeUser(0),
                    claudeAssistant(5, [{ type: "text", text: "first part" }], null, "msg_2"),
                    claudeAssistant(6, [{ type: "text", text: "second part" }], "end_turn", "msg_2"),
                    { type: "system", timestamp: iso(7), subtype: "bookkeeping" },
                ],
                30
            )
        );

        expect(snap.state).toBe("AWAITING-INPUT");
        expect(snap.lastText).toBe("first part\nsecond part");
        expect(snap.asksQuestion).toBe(false);
        expect(snap.lastEventAt).toBe(T0 + 6000);
    });

    it("keeps an earlier message out of the last message text", () => {
        const snap = claudeTurnState(
            input(
                [
                    claudeUser(0),
                    claudeAssistant(2, [{ type: "text", text: "old narration" }], "tool_use", "msg_a"),
                    claudeUser(3, [{ type: "tool_result", content: "ok" }]),
                    claudeAssistant(5, [{ type: "text", text: "the answer" }], "end_turn", "msg_b"),
                ],
                30
            )
        );

        expect(snap.lastText).toBe("the answer");
    });

    it("flags a turn that ended on AskUserQuestion", () => {
        const snap = claudeTurnState(
            input(
                [
                    claudeUser(0),
                    claudeAssistant(
                        5,
                        [
                            { type: "text", text: "Which one?" },
                            { type: "tool_use", name: "AskUserQuestion", input: { questions: [] } },
                        ],
                        "tool_use"
                    ),
                ],
                30
            )
        );

        expect(snap.state).toBe("AWAITING-INPUT");
        expect(snap.asksQuestion).toBe(true);
        expect(snap.lastText).toBe("Which one?");
    });

    it("reports STALLED after the silence limit, but never for a finished turn", () => {
        const running = [
            claudeUser(0),
            claudeAssistant(5, [{ type: "tool_use", name: "Bash", input: {} }], "tool_use"),
        ];
        const finished = [claudeUser(0), claudeAssistant(5, [{ type: "text", text: "done" }], "end_turn")];

        expect(claudeTurnState(input(running, 2000)).state).toBe("STALLED");
        expect(claudeTurnState(input(finished, 2000)).state).toBe("AWAITING-INPUT");
    });

    it("ends the turn when the user pressed Esc, also mid tool call, and never calls it a stall", () => {
        const interrupt = (text: string) => claudeUser(9, [{ type: "text", text }]);
        const running = [
            claudeUser(0),
            claudeAssistant(5, [{ type: "tool_use", name: "Bash", input: {} }], "tool_use"),
        ];
        const plain = claudeTurnState(input([...running, interrupt("[Request interrupted by user]")], 2000));
        const tool = claudeTurnState(input([...running, interrupt("[Request interrupted by user for tool use]")], 30));

        expect(plain.state).toBe("AWAITING-INPUT");
        expect(plain.interrupted).toBe(true);
        expect(tool.state).toBe("AWAITING-INPUT");
        expect(tool.lastEventAt).toBe(T0 + 9000);
    });

    it("does not call an ordinary prompt an interrupt", () => {
        const snap = claudeTurnState(input([claudeUser(0, "please [Request interrupted by user] quote")], 10));

        expect(snap.state).toBe("RUNNING");
        expect(snap.interrupted).toBe(false);
    });

    it("never stalls when the limit is infinite", () => {
        const running = [
            claudeUser(0),
            claudeAssistant(5, [{ type: "tool_use", name: "Bash", input: {} }], "tool_use"),
        ];
        const snap = claudeTurnState({ ...input(running, 100000), stallTimeoutMs: Number.POSITIVE_INFINITY });

        expect(snap.state).toBe("RUNNING");
    });
});

function grokLine(sec: number, sessionUpdate: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const seconds = Math.floor(T0 / 1000) + sec;

    return { timestamp: seconds, method: "_x.ai/session/update", params: { update: { sessionUpdate, ...extra } } };
}

describe("grokTurnState", () => {
    it("is RUNNING while tool calls arrive and ignores hook records", () => {
        const snap = grokTurnState(
            input(
                [
                    grokLine(0, "user_message_chunk", { content: { type: "text", text: "go" } }),
                    grokLine(2, "tool_call"),
                    grokLine(3, "hook_execution"),
                ],
                10
            )
        );

        expect(snap.state).toBe("RUNNING");
        expect(snap.lastEventAt).toBe(T0 + 2000);
    });

    it("ends the turn on turn_completed and joins the message chunks after the last tool call", () => {
        const snap = grokTurnState(
            input(
                [
                    grokLine(0, "user_message_chunk", { content: { type: "text", text: "go" } }),
                    grokLine(1, "agent_message_chunk", { content: { type: "text", text: "narration" } }),
                    grokLine(2, "tool_call"),
                    grokLine(3, "agent_message_chunk", { content: { type: "text", text: "All " } }),
                    grokLine(4, "agent_message_chunk", { content: { type: "text", text: "done." } }),
                    grokLine(5, "turn_completed", { stop_reason: "end_turn" }),
                    grokLine(5, "hook_execution"),
                ],
                60
            )
        );

        expect(snap.state).toBe("AWAITING-INPUT");
        expect(snap.lastText).toBe("All done.");
        expect(snap.lastEventAt).toBe(T0 + 5000);
    });
});

function codexLine(sec: number, type: string, payload: Record<string, unknown>): Record<string, unknown> {
    return { timestamp: iso(sec), type, payload };
}

describe("codexTurnState", () => {
    it("is RUNNING after task_started and AWAITING-INPUT after task_complete, with its last message", () => {
        const running = codexTurnState(
            input(
                [
                    codexLine(0, "event_msg", { type: "task_started" }),
                    codexLine(2, "response_item", { type: "reasoning" }),
                ],
                5
            )
        );
        const finished = codexTurnState(
            input(
                [
                    codexLine(0, "event_msg", { type: "task_started" }),
                    codexLine(4, "event_msg", { type: "task_complete", last_agent_message: "Shipped." }),
                    codexLine(4, "event_msg", { type: "token_count" }),
                ],
                60
            )
        );

        expect(running.state).toBe("RUNNING");
        expect(finished.state).toBe("AWAITING-INPUT");
        expect(finished.lastText).toBe("Shipped.");
        expect(finished.lastEventAt).toBe(T0 + 4000);
    });

    it("stays finished through settings bookkeeping, and only a record of a new turn reopens it", () => {
        const done = [
            codexLine(0, "event_msg", { type: "task_started" }),
            codexLine(4, "event_msg", { type: "task_complete", last_agent_message: "Shipped." }),
            codexLine(5, "event_msg", { type: "thread_settings_applied", thread_settings: { service_tier: null } }),
            codexLine(5, "event_msg", { type: "token_count" }),
        ];
        const settled = codexTurnState(input(done, 60));
        const reopened = codexTurnState(input([...done, codexLine(6, "event_msg", { type: "task_started" })], 8));
        const prompted = codexTurnState(
            input([...done, codexLine(6, "response_item", { type: "message", role: "user" })], 8)
        );

        expect(settled.state).toBe("AWAITING-INPUT");
        expect(settled.lastEventAt).toBe(T0 + 4000);
        expect(reopened.state).toBe("RUNNING");
        expect(prompted.state).toBe("RUNNING");
    });
});

describe("turnStartedAt", () => {
    it("is the record that opened the newest turn, for every provider", () => {
        const claude = claudeTurnState(
            input(
                [
                    claudeUser(0, "first"),
                    claudeAssistant(1, [{ type: "text", text: "ok" }], "end_turn", "m1"),
                    claudeUser(10, "second"),
                    claudeAssistant(11, [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], "tool_use", "m2"),
                    claudeUser(12, [{ type: "tool_result", tool_use_id: "t1", content: "done" }]),
                    { ...claudeUser(13, "<command>"), isMeta: true },
                ],
                20
            )
        );
        expect(claude.turnStartedAt).toBe(T0 + 10_000);

        const codex = codexTurnState(
            input(
                [
                    codexLine(0, "event_msg", { type: "task_started" }),
                    codexLine(4, "event_msg", { type: "task_complete", last_agent_message: "One." }),
                    codexLine(9, "event_msg", { type: "task_started" }),
                    codexLine(12, "event_msg", { type: "task_complete", last_agent_message: "Two." }),
                ],
                20
            )
        );
        expect(codex.turnStartedAt).toBe(T0 + 9000);

        const grok = grokTurnState(
            input(
                [
                    grokLine(0, "user_message_chunk", { content: { type: "text", text: "go" } }),
                    grokLine(1, "turn_completed", { stop_reason: "end_turn" }),
                    grokLine(5, "user_message_chunk", { content: { type: "text", text: "again " } }),
                    grokLine(6, "user_message_chunk", { content: { type: "text", text: "please" } }),
                    grokLine(7, "turn_completed", { stop_reason: "end_turn" }),
                ],
                20
            )
        );
        expect(grok.turnStartedAt).toBe(T0 + 5000);
        expect(codex.turnStartOffset).toBeUndefined();
        expect(
            codexTurnState(input([codexLine(2, "response_item", { type: "reasoning" })], 5)).turnStartedAt
        ).toBeNull();
    });
});

describe("readTurnState", () => {
    it("reads a real file's tail, and returns null for an empty or missing one", () => {
        const dir = mkdtempSync(join(tmpdir(), "turn-state-"));
        const file = join(dir, "s.jsonl");
        const lines = [claudeUser(0), claudeAssistant(5, [{ type: "text", text: "hi" }], "end_turn")];
        writeFileSync(file, `${lines.map((line) => SafeJSON.stringify(line)).join("\n")}\n`);
        const empty = join(dir, "empty.jsonl");
        writeFileSync(empty, "");

        const snap = readTurnState("claude", file, { stallTimeoutMs: 900_000 });

        expect(snap?.state).toBe("AWAITING-INPUT");
        expect(snap?.lastText).toBe("hi");
        expect(readTurnState("claude", empty, { stallTimeoutMs: 900_000 })).toBeNull();
        expect(readTurnState("claude", join(dir, "missing.jsonl"), { stallTimeoutMs: 900_000 })).toBeNull();
    });

    it("gives a Grok turn the byte offset its opening record starts at, so a repeated prompt in one second is told apart", () => {
        const dir = mkdtempSync(join(tmpdir(), "turn-state-"));
        const file = join(dir, "grok.jsonl");
        const text = (value: string) => ({ content: { type: "text", text: value } });
        // The same prompt twice in one whole second; a multi-byte reply in between shifts bytes from characters.
        const first = [
            grokLine(0, "user_message_chunk", text("continue")),
            grokLine(0, "agent_message_chunk", text("ok — žluťoučký kůň")),
            grokLine(0, "turn_completed", { stop_reason: "end_turn" }),
        ]
            .map((line) => `${SafeJSON.stringify(line)}\n`)
            .join("");
        writeFileSync(file, first);
        const before = statSync(file).size;
        const firstTurn = readTurnState("grok", file, { stallTimeoutMs: 900_000 });

        appendFileSync(file, `${SafeJSON.stringify(grokLine(0, "user_message_chunk", text("continue")))}\n`);
        const secondTurn = readTurnState("grok", file, { stallTimeoutMs: 900_000 });

        expect(firstTurn?.turnStartOffset).toBe(0);
        expect(secondTurn?.turnStartedAt).toBe(firstTurn?.turnStartedAt ?? -1);
        expect(secondTurn?.turnStartOffset).toBe(before);
    });

    it("keeps a Grok turn's byte offset exact past a line that holds invalid UTF-8", () => {
        const dir = mkdtempSync(join(tmpdir(), "turn-state-"));
        const file = join(dir, "grok.jsonl");
        const text = (value: string) => ({ content: { type: "text", text: value } });
        const first = [
            grokLine(0, "user_message_chunk", text("first")),
            grokLine(0, "agent_message_chunk", text("ok")),
            grokLine(0, "turn_completed", { stop_reason: "end_turn" }),
        ]
            .map((line) => `${SafeJSON.stringify(line)}\n`)
            .join("");
        writeFileSync(file, first);
        // Two bytes that are not UTF-8: decoded, each becomes a three-byte replacement character.
        appendFileSync(file, Buffer.from([0xff, 0xfe, 0x41, 0x0a]));
        const before = statSync(file).size;
        appendFileSync(file, `${SafeJSON.stringify(grokLine(1, "user_message_chunk", text("second")))}\n`);
        expect(readTurnState("grok", file, { stallTimeoutMs: 900_000 })?.turnStartOffset).toBe(before);
    });
});

const INFINITE = Number.POSITIVE_INFINITY;

function bash(id: string, input: Record<string, unknown>): Record<string, unknown> {
    return { type: "tool_use", id, name: "Bash", input };
}

function claudeResult(sec: number, toolUseId: string): Record<string, unknown> {
    return claudeUser(sec, [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }]);
}

describe("open tool calls and the live activity", () => {
    it("Claude: a call without its result runs, its description first; the result turns it back into thinking", () => {
        const call = claudeAssistant(
            5,
            [bash("t1", { command: "bun test", description: "Run the tests" })],
            "tool_use"
        );
        const running = claudeTurnState(input([claudeUser(0), call], 20, INFINITE));

        expect(running.openTools).toEqual([{ id: "t1", name: "Bash", summary: "Run the tests", startedAt: T0 + 5000 }]);
        expect(liveActivityOf(running)).toMatchObject({
            phase: "tool",
            since: T0 + 5000,
            turnStartedAt: T0,
            openTools: 1,
            stalled: false,
        });

        const answered = claudeTurnState(input([claudeUser(0), call, claudeResult(9, "t1")], 20, INFINITE));
        expect(answered.openTools).toEqual([]);
        expect(liveActivityOf(answered)).toMatchObject({ phase: "thinking", since: T0 + 9000, tool: null });
    });

    it("Claude: parallel calls count, the oldest is named, and a new prompt forgets calls left open", () => {
        const calls = claudeAssistant(5, [bash("a", { command: "ls" }), bash("b", { command: "pwd" })], "tool_use");
        const both = claudeTurnState(input([claudeUser(0), calls], 20, INFINITE));
        expect(liveActivityOf(both)).toMatchObject({ phase: "tool", openTools: 2, tool: { id: "a", summary: "ls" } });

        const next = claudeTurnState(input([claudeUser(0), calls, claudeUser(30, "new task")], 40, INFINITE));
        expect(next.openTools).toEqual([]);
        expect(liveActivityOf(next).phase).toBe("thinking");
    });

    it("Claude: end_turn is idle, Esc is interrupted, and AskUserQuestion or ExitPlanMode wait for the user", () => {
        const done = claudeAssistant(6, [{ type: "text", text: "done" }], "end_turn");
        expect(liveActivityOf(claudeTurnState(input([claudeUser(0), done], 30, INFINITE))).phase).toBe("idle");

        const call = claudeAssistant(5, [bash("t1", { command: "sleep 100" })], "tool_use");
        const esc = claudeUser(8, [{ type: "text", text: "[Request interrupted by user for tool use]" }]);
        const stopped = claudeTurnState(input([claudeUser(0), call, esc], 30, INFINITE));
        expect(liveActivityOf(stopped)).toMatchObject({ phase: "interrupted", openTools: 0, tool: null });

        const ask = claudeAssistant(
            5,
            [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Ship it?" }] } }],
            "tool_use"
        );
        expect(liveActivityOf(claudeTurnState(input([claudeUser(0), ask], 30, INFINITE)))).toMatchObject({
            phase: "waiting",
            question: "Ship it?",
            since: T0 + 5000,
        });

        const plan = claudeAssistant(5, [{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: {} }], "tool_use");
        expect(liveActivityOf(claudeTurnState(input([claudeUser(0), plan], 30, INFINITE)))).toMatchObject({
            phase: "waiting",
            question: "Approve the plan?",
        });
    });

    it("marks a running turn stalled only past the live limit", () => {
        const call = claudeAssistant(5, [bash("t1", { command: "make" })], "tool_use");
        const snap = claudeTurnState(input([claudeUser(0), call], 5, INFINITE));

        expect(liveActivityOf({ ...snap, silenceMs: 9 * 60_000 }).stalled).toBe(false);
        expect(liveActivityOf({ ...snap, silenceMs: 11 * 60_000 })).toMatchObject({ phase: "tool", stalled: true });
    });

    it("Grok: tool_call opens a call named by its tool, a terminal update closes it, turn_completed is idle", () => {
        const call = grokLine(2, "tool_call", {
            toolCallId: "c1",
            title: "run_terminal_command",
            rawInput: { command: "bun test" },
            _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
        });
        const running = grokTurnState(input([grokLine(0, "user_message_chunk"), call], 10, INFINITE));
        expect(running.openTools).toEqual([
            { id: "c1", name: "run_terminal_command", summary: "bun test", startedAt: T0 + 2000 },
        ]);
        expect(liveActivityOf(running).phase).toBe("tool");

        const closed = grokLine(5, "tool_call_update", { toolCallId: "c1", status: "completed" });
        const after = grokTurnState(input([grokLine(0, "user_message_chunk"), call, closed], 10, INFINITE));
        expect(liveActivityOf(after).phase).toBe("thinking");

        const ended = grokTurnState(
            input([grokLine(0, "user_message_chunk"), call, closed, grokLine(6, "turn_completed")], 10, INFINITE)
        );
        expect(liveActivityOf(ended).phase).toBe("idle");
    });

    it("Grok: a call whose first record has only its name takes the summary from a later update", () => {
        const call = grokLine(2, "tool_call", { toolCallId: "c1", title: "read_file" });
        const update = grokLine(3, "tool_call_update", { toolCallId: "c1", title: "Read `/tmp/a.txt`" });
        const snap = grokTurnState(input([grokLine(0, "user_message_chunk"), call, update], 10, INFINITE));

        expect(snap.openTools[0]).toMatchObject({ name: "read_file", summary: "Read `/tmp/a.txt`" });
    });

    it("Codex: an exec script names its command, a function call its argv, and an output closes each", () => {
        const exec = codexLine(2, "response_item", {
            type: "custom_tool_call",
            name: "exec",
            call_id: "x1",
            input: 'text(await tools.exec_command({cmd:"git status --short"}))',
        });
        const shell = codexLine(3, "response_item", {
            type: "function_call",
            name: "shell",
            call_id: "f1",
            arguments: SafeJSON.stringify({ command: ["/bin/zsh", "-lc", "ls -la"] }),
        });
        const started = codexLine(0, "event_msg", { type: "task_started" });
        const snap = codexTurnState(input([started, exec, shell], 10, INFINITE));

        expect(snap.openTools.map((call) => [call.name, call.summary])).toEqual([
            ["exec", "git status --short"],
            ["shell", "ls -la"],
        ]);
        expect(liveActivityOf(snap)).toMatchObject({ phase: "tool", openTools: 2, since: T0 + 2000 });

        const outputs = [
            codexLine(4, "response_item", { type: "custom_tool_call_output", call_id: "x1" }),
            codexLine(5, "response_item", { type: "function_call_output", call_id: "f1" }),
        ];
        expect(liveActivityOf(codexTurnState(input([started, exec, shell, ...outputs], 10, INFINITE))).phase).toBe(
            "thinking"
        );

        const complete = codexLine(6, "event_msg", { type: "task_complete", last_agent_message: "done" });
        const ended = codexTurnState(input([started, exec, shell, complete], 10, INFINITE));
        expect(ended.openTools).toEqual([]);
        expect(liveActivityOf(ended).phase).toBe("idle");
    });

    it("toolSummaryOf reads an object or its JSON text and keeps one short line", () => {
        expect(toolSummaryOf({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
        expect(toolSummaryOf('{"pattern":"TODO"}')).toBe("TODO");
        expect(toolSummaryOf("plain\nsecond line")).toBe("plain");
        expect(toolSummaryOf({ command: "x".repeat(300) })).toHaveLength(160);
        expect(toolSummaryOf({ todos: [] })).toBe("");
    });
});
