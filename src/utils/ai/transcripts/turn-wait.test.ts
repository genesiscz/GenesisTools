import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ActivityState } from "./activity";
import type { TurnSnapshot } from "./turn-state";
import { codexTurnState, grokTurnState, readTurnState } from "./turn-state";
import { looksLikeQuestion, questionOf, TRANSCRIPT_GONE_MS, waitForTurn, watchTurn } from "./turn-wait";

function snap(state: ActivityState, lastEventAt: number | null, turnStartedAt: number | null = null): TurnSnapshot {
    return {
        state,
        lastText: `text@${lastEventAt}`,
        asksQuestion: false,
        question: null,
        interrupted: false,
        lastEventAt,
        turnStartedAt,
        lastActivityAt: 0,
        silenceMs: 0,
    };
}

/** A reader that returns one scripted snapshot per call, then repeats the last. */
function script(...snapshots: (TurnSnapshot | null)[]): { read: () => TurnSnapshot | null; calls: () => number } {
    let calls = 0;

    return {
        read: () => snapshots[Math.min(calls++, snapshots.length - 1)] ?? null,
        calls: () => calls,
    };
}

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let t = 0;

    return {
        now: () => t,
        sleep: async (ms) => {
            t += ms;
        },
    };
}

describe("waitForTurn", () => {
    it("returns at once when the turn is already idle", async () => {
        const reader = script(snap("AWAITING-INPUT", 100));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastText).toBe("text@100");
        expect(result.waitedMs).toBe(0);
    });

    it("waits through RUNNING and returns when the turn ends", async () => {
        const reader = script(snap("RUNNING", 10), snap("RUNNING", 20), snap("AWAITING-INPUT", 30));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.waitedMs).toBe(2000);
    });

    it("reports STALLED without waiting out the timeout", async () => {
        const reader = script(snap("RUNNING", 10), snap("STALLED", 10));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, timeoutMs: 60_000, ...clock() });

        expect(result.outcome).toBe("stalled");
        expect(result.waitedMs).toBe(1000);
    });

    it("times out on the deadline, sleeping no longer than what remains", async () => {
        const c = clock();
        const reader = script(snap("RUNNING", 10));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, timeoutMs: 2500, ...c });

        expect(result.outcome).toBe("timeout");
        expect(result.waitedMs).toBe(2500);
        expect(result.snapshot?.state).toBe("RUNNING");
    });

    it("keeps waiting while the transcript is empty, and times out with no snapshot", async () => {
        const reader = script(null);
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, timeoutMs: 3000, ...clock() });

        expect(result.outcome).toBe("timeout");
        expect(result.snapshot).toBeNull();
    });

    it("ends as stalled when a transcript it read goes away, and keeps the last snapshot", async () => {
        const reader = script(snap("RUNNING", 10), null);
        const result = await waitForTurn({ read: reader.read, pollMs: 5000, ...clock() });

        expect(result.outcome).toBe("stalled");
        expect(result.waitedMs).toBe(5000 + TRANSCRIPT_GONE_MS);
        expect(result.snapshot?.state).toBe("RUNNING");
    });

    it("a transcript that is unreadable once and back again keeps waiting", async () => {
        const reader = script(snap("RUNNING", 10), null, snap("RUNNING", 20), snap("AWAITING-INPUT", 30));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
    });

    it("with next, ignores the turn that was already finished and waits for a later one", async () => {
        const reader = script(
            snap("AWAITING-INPUT", 100),
            snap("AWAITING-INPUT", 100),
            snap("RUNNING", 150),
            snap("AWAITING-INPUT", 200)
        );
        const result = await waitForTurn({ read: reader.read, next: true, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastText).toBe("text@200");
        expect(result.waitedMs).toBe(2000);
    });

    it("with next, catches a turn that started and ended between two polls", async () => {
        const reader = script(snap("AWAITING-INPUT", 100), snap("AWAITING-INPUT", 100), snap("AWAITING-INPUT", 180));
        const result = await waitForTurn({ read: reader.read, next: true, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastEventAt).toBe(180);
    });

    it("with turnStartedAfter, the end of the turn that was already running is not the answer", async () => {
        const reader = script(
            snap("RUNNING", 90, 50),
            snap("AWAITING-INPUT", 100, 50),
            snap("RUNNING", 130, 120),
            snap("AWAITING-INPUT", 180, 120)
        );
        const result = await waitForTurn({
            read: reader.read,
            next: true,
            turnStartedAfter: 110,
            pollMs: 1000,
            ...clock(),
        });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastEventAt).toBe(180);
    });

    it("with turnStartedAfter, a turn whose start is outside the tail still counts", async () => {
        const reader = script(snap("RUNNING", 90, null), snap("AWAITING-INPUT", 100, null));
        const result = await waitForTurn({
            read: reader.read,
            next: true,
            turnStartedAfter: 110,
            pollMs: 1000,
            ...clock(),
        });

        expect(result.outcome).toBe("done");
    });

    it("with next, a turn that ends in the baseline's second still counts once it was seen running", async () => {
        // Grok writes epoch seconds: the idle baseline and the next turn's end share one timestamp.
        const second = 1_760_000_000_000;
        const reader = script(
            snap("AWAITING-INPUT", second),
            snap("AWAITING-INPUT", second),
            snap("RUNNING", second),
            snap("AWAITING-INPUT", second)
        );
        const result = await waitForTurn({
            read: reader.read,
            next: true,
            pollMs: 1000,
            timeoutMs: 10_000,
            ...clock(),
        });

        expect(result.outcome).toBe("done");
        expect(result.waitedMs).toBe(2000);
    });

    it("with next, an idle session whose time never moves is not a finished turn", async () => {
        const second = 1_760_000_000_000;
        const reader = script(snap("AWAITING-INPUT", second));
        const result = await waitForTurn({ read: reader.read, next: true, pollMs: 1000, timeoutMs: 3000, ...clock() });

        expect(result.outcome).toBe("timeout");
    });

    it("with next on a running turn, returns when that turn ends", async () => {
        const reader = script(snap("RUNNING", 10), snap("RUNNING", 20), snap("AWAITING-INPUT", 30));
        const result = await waitForTurn({ read: reader.read, next: true, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
    });

    it("stops at once when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const reader = script(snap("RUNNING", 10));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, signal: controller.signal, ...clock() });

        expect(result.outcome).toBe("timeout");
    });
});

describe("questions asked while the turn keeps running", () => {
    it("are collected once each and returned with the finished turn, without ending the wait", async () => {
        const asking = (question: string | null, at: number): TurnSnapshot => ({ ...snap("RUNNING", at), question });
        const reader = script(
            asking("Should I also update the README?", 10),
            asking("Should I also update the README?", 11),
            asking(null, 12),
            snap("AWAITING-INPUT", 20)
        );
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.questions).toEqual(["Should I also update the README?"]);
    });

    it("the wording heuristic is kept but off: it counts only when switched on", () => {
        const worded = { ...snap("RUNNING", 1), lastText: "Done with A.\n\nShall I do B?" };

        expect(looksLikeQuestion("❓ DECISION 3: pick a or b")).toBe(true);
        expect(looksLikeQuestion("Is it? No.\n\nIt is fixed.")).toBe(false);
        expect(questionOf(worded)).toBeNull();
        expect(questionOf(worded, true)).toBe("Done with A.\n\nShall I do B?");
    });

    const input = (records: Record<string, unknown>[]) => ({
        records,
        lastModified: 1_000,
        now: 2_000,
        stallTimeoutMs: Number.POSITIVE_INFINITY,
    });
    const codexCall = (name: string, id: string, question: string) => ({
        type: "response_item",
        timestamp: 900,
        payload: {
            type: "function_call",
            name,
            call_id: id,
            arguments: SafeJSON.stringify({ questions: [{ id: "q", question, options: [] }] }),
        },
    });
    const codexOutput = (id: string) => ({
        type: "response_item",
        timestamp: 950,
        payload: { type: "function_call_output", call_id: id, output: "{}" },
    });
    const taskComplete = { type: "event_msg", timestamp: 990, payload: { type: "task_complete" } };

    it("Codex: an unanswered request_user_input waits on the user; an answered one does not", () => {
        const open = codexTurnState(input([codexCall("request_user_input", "c1", "Which branch?")]));
        expect(open).toMatchObject({ state: "AWAITING-INPUT", asksQuestion: true, question: "Which branch?" });

        const answered = codexTurnState(
            input([codexCall("request_user_input", "c1", "Which branch?"), codexOutput("c1")])
        );
        expect(answered.asksQuestion).toBe(false);
    });

    it("Codex: a turn whose last call is request_user_input_async ends on that question", () => {
        const asked = [codexCall("request_user_input_async", "c2", "Ship it?"), codexOutput("c2")];

        expect(codexTurnState(input([...asked, taskComplete]))).toMatchObject({
            asksQuestion: true,
            question: "Ship it?",
        });
        // Still running: the question is visible for `wait` to collect, but nothing waits on it.
        expect(codexTurnState(input(asked))).toMatchObject({ asksQuestion: false, question: "Ship it?" });
    });

    it("Grok: ask_user_question is open until its tool_call_update; message wording never counts", () => {
        const update = (sessionUpdate: string, extra: Record<string, unknown>) => ({
            timestamp: 1,
            params: { update: { sessionUpdate, ...extra } },
        });
        const ask = update("tool_call", {
            toolCallId: "t1",
            rawInput: { questions: [{ question: "Keep the old API?" }] },
            _meta: { "x.ai/tool": { kind: "ask_user" } },
        });

        expect(grokTurnState(input([ask]))).toMatchObject({ state: "AWAITING-INPUT", asksQuestion: true });
        expect(
            grokTurnState(input([ask, update("tool_call_update", { toolCallId: "t1", status: "completed" })]))
                .asksQuestion
        ).toBe(false);
        // A progress update is not an answer: the question stays open.
        expect(
            grokTurnState(input([ask, update("tool_call_update", { toolCallId: "t1", status: "in_progress" })]))
        ).toMatchObject({ state: "AWAITING-INPUT", asksQuestion: true, question: "Keep the old API?" });
        expect(
            grokTurnState(input([ask, update("tool_call_update", { toolCallId: "t1", status: "failed" })])).asksQuestion
        ).toBe(false);

        const wording = update("agent_message_chunk", { content: { type: "text", text: "Shall I do B? ❓" } });
        expect(grokTurnState(input([wording]))).toMatchObject({ asksQuestion: false, question: null });
    });
});

describe("watchTurn on a real transcript", () => {
    const line = (record: Record<string, unknown>): string => `${SafeJSON.stringify(record)}\n`;
    const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

    it("wakes on the write that ends the turn, long before the safety poll", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "turn-watch-")), "s.jsonl");
        writeFileSync(file, line({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }));
        setTimeout(() => {
            appendFileSync(
                file,
                line({
                    type: "assistant",
                    timestamp: at(0),
                    message: {
                        id: "m1",
                        role: "assistant",
                        content: [{ type: "text", text: "done" }],
                        stop_reason: "end_turn",
                    },
                })
            );
        }, 150);
        const started = Date.now();

        const result = await watchTurn({
            path: file,
            read: () => readTurnState("claude", file, { stallTimeoutMs: 60_000 }),
            pollMs: 20_000,
            timeoutMs: 10_000,
        });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastText).toBe("done");
        expect(Date.now() - started).toBeLessThan(5_000);
    });
});

describe("a snapshot callback that throws", () => {
    const failing = () => {
        throw new Error("stream read failed");
    };

    it("does not stop waitForTurn from judging the snapshot", async () => {
        const reader = script(snap("RUNNING", 10), snap("STALLED", 10));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, onSnapshot: failing, ...clock() });

        expect(result.outcome).toBe("stalled");
    });

    it("does not keep watchTurn from reaching STALLED before its deadline", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "turn-watch-")), "s.jsonl");
        writeFileSync(file, "{}\n");
        const reader = script(snap("RUNNING", 10), snap("STALLED", 10));
        let calls = 0;

        const result = await watchTurn({
            path: file,
            read: reader.read,
            pollMs: 100,
            timeoutMs: 5_000,
            onSnapshot: () => {
                calls += 1;
                failing();
            },
        });

        expect(result.outcome).toBe("stalled");
        expect(calls).toBeGreaterThanOrEqual(2);
    });
});

describe("watchTurn deadline", () => {
    it("times out on time even when the transcript stays quiet and the poll is slow", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "turn-watch-")), "quiet.jsonl");
        writeFileSync(
            file,
            `${SafeJSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "go" } })}\n`
        );
        const started = Date.now();

        const result = await watchTurn({
            path: file,
            read: () => readTurnState("claude", file, { stallTimeoutMs: 60_000 }),
            pollMs: 20_000,
            timeoutMs: 300,
        });

        expect(result.outcome).toBe("timeout");
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});
