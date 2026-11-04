import { describe, expect, test } from "bun:test";
import type { FleetEntry } from "@genesiscz/utils/ai/live-sessions/fleet";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import {
    interruptBoardSession,
    interruptSession,
    receiptOfDelivery,
    SEND_TIMINGS,
    type SendEdges,
    type SendTiming,
    type SessionSendRequest,
    senderOf,
    sendTimingsOf,
    sendToBoardSession,
    sendToSession,
} from "./index";

/** Edges that record which transport ran and touch no session, pane or queue. */
function fakeEdges(calls: string[]): SendEdges {
    return {
        deliverNow: async (request) => {
            calls.push(`now:${request.sessionId}`);
            return { outcome: "delivered", timing: request.timing, route: "claude-peer", detail: "peer" };
        },
        codexQueue: async (request) => {
            calls.push(`codex-queue:${request.sessionId}`);
            return { outcome: "queued-daemon", timing: request.timing, route: "codex-queue", detail: "daemon" };
        },
        enqueue: async (request) => {
            calls.push(`enqueue:${request.sessionId}`);
            return {
                outcome: "queued-session",
                timing: request.timing,
                route: "session-queue",
                detail: "q",
                queueId: "m1",
            };
        },
        pressKey: async (address, key) => {
            calls.push(`key:${address.sessionId}:${key}`);
            return { outcome: "sent", route: "cmux-key", detail: `${key} pressed` };
        },
    };
}

function request(provider: SessionSendRequest["provider"], timing: SendTiming): SessionSendRequest {
    return {
        provider,
        sessionId: "s-1",
        sourceHome: "/home/work/.agent",
        text: "hello",
        timing,
        idempotencyKey: "k-1",
    };
}

describe("session send (M5)", () => {
    test("every harness has a sender with all three timings and an interrupt", () => {
        for (const provider of ACCOUNT_PROVIDER_ALIASES) {
            const sender = senderOf(provider);
            expect(Object.keys(sender.timings).sort()).toEqual([...SEND_TIMINGS].sort());
            expect(sender.interrupt).toBeDefined();
        }
    });

    test("each harness routes each timing to its own transport", async () => {
        const expected: Record<string, Record<SendTiming, string | null>> = {
            claude: { now: "now", "next-turn": null, later: "enqueue" },
            codex: { now: "now", "next-turn": "codex-queue", later: "enqueue" },
            grok: { now: "now", "next-turn": null, later: "enqueue" },
        };

        for (const provider of ACCOUNT_PROVIDER_ALIASES) {
            for (const timing of SEND_TIMINGS) {
                const calls: string[] = [];
                const receipt = await sendToSession(request(provider, timing), fakeEdges(calls));
                const transport = expected[provider]?.[timing];

                if (transport === null) {
                    expect(receipt.outcome).toBe("refused");
                    expect(receipt.detail.length).toBeGreaterThan(10);
                    expect(calls).toEqual([]);
                    expect(sendTimingsOf(provider)[timing].supported).toBe(false);
                } else {
                    expect(calls).toEqual([`${transport}:s-1`]);
                    expect(sendTimingsOf(provider)[timing].supported).toBe(true);
                }
            }
        }
    });

    test("an empty message is refused before any transport", async () => {
        const calls: string[] = [];
        const receipt = await sendToSession({ ...request("claude", "now"), text: "  " }, fakeEdges(calls));
        expect(receipt.outcome).toBe("refused");
        expect(calls).toEqual([]);
    });

    test("a delivery result maps to delivered, queued-session or refused", () => {
        expect(receiptOfDelivery({ channel: "claude-peer", delivered: true, target: "peer" }, "now")).toMatchObject({
            outcome: "delivered",
            route: "claude-peer",
        });
        expect(
            receiptOfDelivery({ channel: "queued", delivered: false, queueId: "m9", error: "pane busy" }, "now")
        ).toMatchObject({ outcome: "queued-session", queueId: "m9", detail: "pane busy" });
        expect(receiptOfDelivery({ channel: "queued", delivered: false, error: "no pane" }, "now")).toMatchObject({
            outcome: "refused",
            detail: "no pane",
        });
    });

    test("an interrupt presses the harness's key through the guarded pane edge", async () => {
        const calls: string[] = [];
        const receipt = await interruptSession(
            { provider: "codex", sessionId: "s-2", sourceHome: null },
            fakeEdges(calls)
        );
        expect(receipt.outcome).toBe("sent");
        expect(calls).toEqual(["key:s-2:escape"]);
    });
});

function entry(partial: Partial<FleetEntry>): FleetEntry {
    return {
        provider: "claude",
        sessionId: "s-1",
        match: "journal",
        surface: null,
        process: null,
        cwd: null,
        transcriptPath: null,
        phase: "idle",
        stalled: false,
        label: "idle",
        activity: null,
        stuck: null,
        transcript: null,
        lastText: null,
        lastActivityAt: null,
        ...partial,
    };
}

describe("board sends", () => {
    test("a board key is located again and sent to the exact session", async () => {
        const calls: string[] = [];
        const receipt = await sendToBoardSession(
            { key: "claude:s-1", text: "go on", timing: "now", idempotencyKey: "k" },
            { fleet: async () => [entry({})], edges: fakeEdges(calls) }
        );
        expect(receipt).toMatchObject({ key: "claude:s-1", outcome: "delivered" });
        expect(calls).toEqual(["now:s-1"]);
    });

    test("a session that ended, or that has no id, is refused and nothing runs", async () => {
        const calls: string[] = [];
        const gone = await sendToBoardSession(
            { key: "claude:s-404", text: "x", timing: "now" },
            { fleet: async () => [entry({})], edges: fakeEdges(calls) }
        );
        expect(gone).toMatchObject({ outcome: "refused", detail: "the session is no longer live" });

        const noId = await interruptBoardSession(
            { key: "grok:pid:4242" },
            {
                fleet: async () => [
                    entry({
                        provider: "grok",
                        sessionId: null,
                        process: {
                            pid: 4242,
                            ppid: 1,
                            tty: null,
                            provider: "grok",
                            argvSessionId: null,
                            startMs: null,
                            command: "grok",
                        },
                    }),
                ],
                edges: fakeEdges(calls),
            }
        );
        expect(noId.outcome).toBe("refused");
        expect(calls).toEqual([]);
    });
});
