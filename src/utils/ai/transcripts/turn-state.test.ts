import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeTurnState, codexTurnState, grokTurnState, readTurnState, type TurnStateInput } from "./turn-state";

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
});
