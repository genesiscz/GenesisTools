import { describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ActivityState } from "./activity";
import type { TurnSnapshot } from "./turn-state";
import { codexTurnState, grokTurnState, readTurnState, TURN_TAIL_BYTES } from "./turn-state";
import { looksLikeQuestion, questionOf, TRANSCRIPT_GONE_MS, turnAnswers, waitForTurn, watchTurn } from "./turn-wait";

function snap(state: ActivityState, lastEventAt: number | null, turnStartedAt: number | null = null): TurnSnapshot {
    return {
        state,
        lastText: `text@${lastEventAt}`,
        asksQuestion: false,
        question: null,
        interrupted: false,
        turnError: null,
        lastEventAt,
        turnStartedAt,
        lastActivityAt: 0,
        silenceMs: 0,
        openTools: [],
        handedBackAt: null,
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

describe("round 33 tail-only answering turns", () => {
    const sentAt = Date.parse("2026-10-17T12:00:00Z");
    const line = (at: number, payload: Record<string, unknown>): string =>
        `${SafeJSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload })}\n`;

    it.each(["bytes", "newer", "after"] as const)("accepts a long answer under a %s fence", async (fence) => {
        const file = join(mkdtempSync(join(tmpdir(), "answer-tail-")), "rollout.jsonl");
        const baseline = line(sentAt - 1000, { type: "task_complete", last_agent_message: "previous" });
        const middle = line(sentAt + 2000, { type: "agent_message", message: "x".repeat(1024) });
        writeFileSync(
            file,
            baseline +
                line(sentAt + 1000, { type: "task_started" }) +
                middle.repeat(Math.ceil(TURN_TAIL_BYTES / middle.length) + 5) +
                line(sentAt + 3000, { type: "task_complete", last_agent_message: "long answer" })
        );
        const read = () => readTurnState("codex", file, { now: sentAt + 4000, stallTimeoutMs: 60_000 });
        expect(read()?.turnStartedAt).toBeNull();
        const options =
            fence === "bytes"
                ? { openedFromByte: Buffer.byteLength(baseline), turnNewerThan: sentAt }
                : fence === "newer"
                  ? { turnNewerThan: sentAt }
                  : { turnStartedAfter: sentAt };
        const result = await waitForTurn({ read, ...options, ...clock(), pollMs: 100, timeoutMs: 200 });
        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastText).toBe("long answer");
    });

    it.each(["bytes", "newer", "after"] as const)(
        "rejects a tail overlapping the send under a %s fence",
        async (fence) => {
            const file = join(mkdtempSync(join(tmpdir(), "predecessor-tail-")), "rollout.jsonl");
            const old = line(sentAt - 1000, { type: "agent_message", message: "x".repeat(1024) });
            const beforeSend =
                line(sentAt - 2000, { type: "task_started" }) + old.repeat(Math.ceil(TURN_TAIL_BYTES / old.length) + 5);
            writeFileSync(
                file,
                beforeSend + line(sentAt + 1000, { type: "task_complete", last_agent_message: "previous" })
            );
            const read = () => readTurnState("codex", file, { now: sentAt + 2000, stallTimeoutMs: 60_000 });
            expect(read()?.turnStartedAt).toBeNull();
            const options =
                fence === "bytes"
                    ? { openedFromByte: Buffer.byteLength(beforeSend), turnNewerThan: sentAt }
                    : fence === "newer"
                      ? { turnNewerThan: sentAt }
                      : { turnStartedAfter: sentAt };
            const result = await waitForTurn({ read, ...options, ...clock(), pollMs: 100, timeoutMs: 200 });
            expect(result.outcome).toBe("timeout");
        }
    );
});

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

    it("with turnStartedAfter, a silent turn that began before the send is not a stall of the answer", async () => {
        // An idle session whose last turn never wrote its end reads STALLED; the message starts a new turn seconds later.
        const reader = script(
            snap("STALLED", 40, 30),
            snap("STALLED", 40, 30),
            snap("RUNNING", 130, 120),
            snap("AWAITING-INPUT", 180, 120)
        );
        const result = await waitForTurn({ read: reader.read, turnStartedAfter: 110, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastEventAt).toBe(180);
    });

    it("with turnStartedAfter, the answering turn that goes silent is still a stall", async () => {
        const reader = script(snap("RUNNING", 130, 120), snap("STALLED", 130, 120));
        const result = await waitForTurn({ read: reader.read, turnStartedAfter: 110, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("stalled");
    });

    it("with turnNewerThan, the turn that was current before the send is not the answer even inside the tolerance", async () => {
        // The send was at 110 with 20 ms of tolerance; the previous turn began at 100 and was still running.
        const reader = script(
            snap("RUNNING", 105, 100),
            snap("AWAITING-INPUT", 115, 100),
            snap("RUNNING", 130, 120),
            snap("AWAITING-INPUT", 180, 120)
        );
        const result = await waitForTurn({
            read: reader.read,
            next: true,
            turnStartedAfter: 90,
            turnNewerThan: 100,
            pollMs: 1000,
            ...clock(),
        });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastEventAt).toBe(180);
        expect(turnAnswers(100, { turnStartedAfter: 90, turnNewerThan: 100 })).toBe(false);
        expect(turnAnswers(120, { turnStartedAfter: 90, turnNewerThan: 100 })).toBe(true);
    });

    it("with turnNewerThan, a Grok reply that opened in the baseline's very second counts by where it opened", async () => {
        // Grok stamps whole seconds: the pre-send turn and the reply both opened at 10_000. The transcript held
        // 4_000 bytes before the send; the pre-send turn opened at byte 3_000, the reply at byte 4_200.
        const second = 10_000;
        const turn = (state: ActivityState, lastEventAt: number, turnStartOffset: number): TurnSnapshot => ({
            ...snap(state, lastEventAt, second),
            turnStartOffset,
        });
        const reader = script(
            turn("AWAITING-INPUT", second, 3_000),
            turn("RUNNING", second, 4_200),
            turn("AWAITING-INPUT", second, 4_200)
        );
        const window = { turnStartedAfter: second - 500, turnNewerThan: second, openedFromByte: 4_000 };
        // A deadline, so a regression fails as a timeout instead of waiting for ever.
        const result = await waitForTurn({
            read: reader.read,
            next: true,
            ...window,
            timeoutMs: 10_000,
            pollMs: 1000,
            ...clock(),
        });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.turnStartOffset).toBe(4_200);
        // The pre-send turn never counts, whatever its prompt was (the same message can be sent twice).
        expect(turnAnswers(second, window, 3_000)).toBe(false);
        expect(turnAnswers(second, window, 4_000)).toBe(true);
        // Without the size before the send, or without the turn's position, an equal start stays excluded.
        expect(turnAnswers(second, { ...window, openedFromByte: undefined }, 4_200)).toBe(false);
        expect(turnAnswers(second, window, undefined)).toBe(false);
    });

    it("with turnStartedAfter, an unknown predecessor never counts before an identifiable answer", async () => {
        const reader = script(
            snap("RUNNING", 90, null),
            snap("AWAITING-INPUT", 100, null),
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
        expect(result.snapshot?.turnStartedAt).toBe(120);
        expect(result.waitedMs).toBe(2000);
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
        // A new prompt starts another turn: the question left open in the last one is not this turn's.
        const prompt = update("user_message_chunk", { content: { type: "text", text: "never mind, do X" } });
        expect(grokTurnState(input([ask, prompt]))).toMatchObject({ asksQuestion: false, question: null });
        expect(grokTurnState(input([ask, prompt])).state).not.toBe("AWAITING-INPUT");

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

describe("round 33 fenced wait bounds", () => {
    it.each([30, null])("bounds a permanently stalled predecessor with turn start %s", async (turnStart) => {
        let time = 0;
        const result = await waitForTurn({
            read: () => snap("STALLED", 40, turnStart),
            turnStartedAfter: 110,
            pollMs: 31 * 60_000,
            now: () => time,
            sleep: async (ms) => {
                time += ms;
                if (time > 2 * 60 * 60_000) {
                    throw new Error("the fenced wait has no finite default deadline");
                }
            },
        });
        expect(result.outcome).toBe("timeout");
        expect(result.waitedMs).toBe(30 * 60_000);
    });

    it("an explicit shorter deadline also bounds an unknown finished predecessor", async () => {
        const result = await waitForTurn({
            read: () => snap("FINISHED", 100, null),
            turnNewerThan: 100,
            timeoutMs: 2500,
            pollMs: 1000,
            ...clock(),
        });
        expect(result.outcome).toBe("timeout");
        expect(result.waitedMs).toBe(2500);
    });

    it.each([30, null])("arms the same finite default deadline for the watcher, turn start %s", async (turnStart) => {
        const file = join(mkdtempSync(join(tmpdir(), "fenced-watch-")), "stalled.jsonl");
        writeFileSync(file, "{}\n");
        const delays: Array<number | undefined> = [];
        const original = globalThis.setTimeout;
        const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
            delays.push(ms);
            return original(callback, ms === 30 * 60_000 ? 10 : ms);
        }) as typeof setTimeout);
        try {
            const result = await watchTurn({
                path: file,
                read: () => snap("STALLED", 40, turnStart),
                turnStartedAfter: 110,
                pollMs: 20_000,
                signal: AbortSignal.timeout(1000),
            });
            expect(result.outcome).toBe("timeout");
            expect(delays).toContain(30 * 60_000);
        } finally {
            timers.mockRestore();
        }
    });
});
