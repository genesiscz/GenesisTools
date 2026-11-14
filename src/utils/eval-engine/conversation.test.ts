import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { type ConversationDeps, runConversation } from "./conversation";
import { parseScenarios, type Scenario } from "./document";
import { EvalSystemError, type ModelRef } from "./system";
import { type FakeScript, type FakeTurn, fakeSystem } from "./testing";

const Signals = z.object({
    offered: z.array(z.object({ label: z.string(), startsAt: z.string() })),
    emergency: z.boolean(),
    booking: z.object({ startsAt: z.string() }).nullable(),
});
type Signals = z.infer<typeof Signals>;
const Tools = ["find_free_slots", "book_appointment", "request_human"] as const;
const Model: ModelRef = { id: "fake", label: "Fake", limitKey: "fake" };
const Judge: ModelRef = { id: "judge", label: "Judge", limitKey: "judge" };
const Offered = [
    { label: "Po 8:00", startsAt: "2026-11-16T07:00:00Z" },
    { label: "Po 9:00", startsAt: "2026-11-16T08:00:00Z" },
];

function system(
    reply: (turn: number, text: string) => FakeTurn<Signals>,
    extra: Partial<FakeScript<unknown, Signals, (typeof Tools)[number]>> = {}
) {
    return fakeSystem({
        tools: Tools,
        signals: Signals,
        defaultSignals: { offered: [], emergency: false, booking: null },
        reply: (c) => reply(c.turn, c.text),
        ...extra,
    });
}

function scenario(input: unknown): Scenario {
    const parsed = parseScenarios(
        input,
        system(() => ({})),
        "stdin"
    );
    if (!parsed.ok) {
        assert.fail(JSON.stringify(parsed.issues));
    }
    return parsed.scenarios[0];
}

async function play(
    s: Scenario,
    fake: ReturnType<typeof system>,
    overrides: Partial<ConversationDeps<unknown, Signals, unknown>> = {}
) {
    const connection = fake.connect(undefined);
    return runConversation(
        {
            key: "k~fake~current~r1",
            repeat: 1,
            attempt: 1,
            scenario: s,
            cell: { scenario: s.doc.id, scenarioHash: s.hash, model: "fake", variant: "current" },
            setup: {},
        },
        {
            connection,
            signals: Signals,
            model: Model,
            runId: "run-1",
            limited: (_key, task) => task(),
            harness: { judge: null, simulator: null },
            putPrompt: async (text) => `p${text.length}`,
            keepGoing: false,
            signal: new AbortController().signal,
            now: () => new Date("2026-11-10T10:00:00Z"),
            ...overrides,
        }
    );
}

describe("runConversation", () => {
    it("sends each turn once, fills bindings, and checks the picked time", async () => {
        const fake = system((turn) =>
            turn === 1
                ? {
                      reply: "Mám dva termíny.",
                      toolCalls: [{ name: "find_free_slots", input: {} }],
                      signals: { offered: Offered },
                      systemPrompt: "PROMPT",
                  }
                : {
                      reply: "Rezervováno.",
                      toolCalls: [{ name: "book_appointment", input: { starts_at: "2026-11-16T09:00:00+01:00" } }],
                      signals: { booking: { startsAt: "2026-11-16T08:00:00Z" } },
                  }
        );
        const record = await play(
            scenario({
                id: "picks",
                steps: [
                    { user: "Termín?", expect: [{ check: { signal: "offered", size: { min: 2 } } }] },
                    {
                        bind: { pick: "offered[1]" },
                        user: "Beru {{pick.label}}.",
                        expect: [
                            {
                                id: "books",
                                check: {
                                    tool: "book_appointment",
                                    args: { starts_at: { instant: "{{pick.startsAt}}" } },
                                },
                            },
                        ],
                    },
                ],
                final: [{ check: { signal: "booking.startsAt", instant: "{{pick.startsAt}}" } }],
            }),
            fake
        );
        assert.deepEqual(
            fake.log.sent.map((s) => s.text),
            ["Termín?", "Beru Po 9:00."]
        );
        assert.equal(record.outcome, "passed");
        assert.equal(record.completed, true);
        assert.equal(record.turns[0].promptHash, "p6");
        assert.deepEqual(record.bindings, { pick: Offered[1] });
        assert.equal(record.final[0].result, "pass");
        assert.deepEqual(fake.log.closed, [{ key: "k~fake~current~r1", outcome: "passed" }]);
        assert.equal(fake.log.opened[0].runId, "run-1");
    });

    it("an unreadable binding fails the previous turn and stops", async () => {
        const fake = system(() => ({ reply: "Jeden termín.", signals: { offered: [Offered[0]] } }));
        const record = await play(
            scenario({ id: "b", steps: [{ user: "a" }, { bind: { pick: "offered[1]" }, user: "{{pick.label}}" }] }),
            fake
        );
        assert.equal(fake.log.sent.length, 1);
        assert.equal(record.outcome, "failed");
        assert.equal(record.completed, false);
        const verdict = record.turns[0].verdicts[0];
        assert.equal(verdict.id, "binding:pick");
        assert.equal(verdict.place, "binding");
        assert.match(verdict.reason, /needed offered\[1\]; offered has 1 item, no \[1\]/);
    });

    it("keeps a proven failure when an infrastructure error follows it, and never rethrows", async () => {
        const fake = system((turn) =>
            turn === 1
                ? { reply: "Volejte 155.", signals: { emergency: true } }
                : { error: new EvalSystemError("transient", "stream dropped") }
        );
        const record = await play(
            scenario({
                id: "c",
                steps: [
                    { user: "a", expect: [{ severity: "safety", check: { signal: "emergency", is: false } }] },
                    { user: "b" },
                ],
            }),
            fake,
            { keepGoing: true }
        );
        assert.equal(record.outcome, "failed");
        assert.equal(record.safetyMiss, true);
        assert.deepEqual(record.brokenBy, { kind: "transient", message: "stream dropped" });
        assert.deepEqual(
            fake.log.closed.map((c) => c.outcome),
            ["failed"]
        );
    });

    it("throws an infrastructure error before any proven failure and closes the conversation as discarded", async () => {
        const fake = system(() => ({ error: new EvalSystemError("rate-limit", "429", { retryAfterMs: 500 }) }));
        await assert.rejects(
            play(scenario({ id: "d", steps: [{ user: "a" }] }), fake),
            (e: unknown) => e instanceof EvalSystemError && e.kind === "rate-limit"
        );
        assert.deepEqual(
            fake.log.closed.map((c) => c.outcome),
            ["discarded"]
        );
    });

    it("treats signals outside the schema as blocked", async () => {
        const fake = fakeSystem({
            tools: Tools,
            signals: Signals,
            defaultSignals: { offered: [], emergency: false, booking: null },
            reply: () => ({ signals: { emergency: undefined } }),
        });
        await assert.rejects(
            play(scenario({ id: "e", steps: [{ user: "a" }] }), fake),
            (e: unknown) => e instanceof EvalSystemError && e.kind === "blocked"
        );
    });

    it("stops at the first gate failure unless keepGoing", async () => {
        const fake = system(() => ({ reply: "x" }));
        const s = scenario({
            id: "f",
            steps: [{ user: "a", expect: [{ check: { tool: "find_free_slots" } }] }, { user: "b" }],
        });
        assert.equal((await play(s, fake)).turns.length, 1);
        assert.equal((await play(s, fake, { keepGoing: true })).turns.length, 2);
    });

    it("choose plays the first branch whose check passes on the previous turn, and records it", async () => {
        const asks = system((turn) => (turn === 1 ? { reply: "Kdy můžete?" } : { reply: "Dobře." }));
        const s = scenario({
            id: "g",
            steps: [
                { user: "Bolí mě zub." },
                {
                    choose: [
                        {
                            name: "offered",
                            when: { tool: "find_free_slots" },
                            bind: { pick: "offered[0]" },
                            user: "Beru {{pick.label}}",
                        },
                        { name: "asked", otherwise: true, user: "Zítra ráno." },
                    ],
                },
            ],
        });
        const record = await play(s, asks);
        assert.equal(record.turns[1].choice, "asked");
        assert.equal(record.turns[1].user.text, "Zítra ráno.");
        const offers = system((turn) =>
            turn === 1
                ? { toolCalls: [{ name: "find_free_slots", input: {} }], signals: { offered: Offered } }
                : { reply: "ok" }
        );
        const second = await play(s, offers);
        assert.equal(second.turns[1].choice, "offered");
        assert.equal(second.turns[1].user.text, "Beru Po 8:00");
        const noMatch = scenario({
            id: "h",
            steps: [{ user: "a" }, { choose: [{ when: { tool: "request_human" }, user: "b" }] }],
        });
        const stopped = await play(noMatch, asks);
        assert.equal(stopped.outcome, "failed");
        assert.equal(stopped.turns[0].verdicts[0].id, "choose:s2");
    });

    it("asks the judge through complete, and a broken judge is inconclusive", async () => {
        const answering = system(() => ({ reply: "Kdy můžete přijít?" }), {
            complete: (request) => ({
                text: request.purpose === "judge" ? '{"answer":"yes","reason":"it asks"}' : "",
                usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.01 },
            }),
        });
        const s = scenario({ id: "j", steps: [{ user: "a", expect: [{ check: { judge: "Does it ask when?" } }] }] });
        const record = await play(s, answering, { harness: { judge: Judge, simulator: null } });
        assert.equal(record.outcome, "passed");
        assert.equal(record.harnessUsage.costUsd, 0.01);
        assert.equal(answering.log.completions[0].model, "judge");
        const broken = system(() => ({ reply: "x" }), {
            complete: () => {
                throw new EvalSystemError("transient", "judge down");
            },
        });
        const failed = await play(s, broken, { harness: { judge: Judge, simulator: null } });
        assert.equal(failed.outcome, "inconclusive");
        assert.match(failed.turns[0].verdicts[0].reason, /the judge failed: judge down/);
        assert.equal((await play(s, answering)).outcome, "inconclusive");
    });

    it("plays a simulated block until the stop word or until", async () => {
        let n = 0;
        const fake = system(
            (turn) => (turn === 2 ? { toolCalls: [{ name: "book_appointment", input: {} }] } : { reply: "?" }),
            {
                complete: () => ({
                    text: ++n > 5 ? "###STOP###" : `message ${n}`,
                    usage: { inputTokens: 1, outputTokens: 1 },
                }),
            }
        );
        const s = scenario({
            id: "sim",
            steps: [
                {
                    simulate: {
                        persona: "You are a patient.",
                        goal: "Book.",
                        maxTurns: 4,
                        until: { tool: "book_appointment" },
                    },
                },
            ],
        });
        const record = await play(s, fake, {
            harness: { judge: null, simulator: { id: "sim", label: "Sim", limitKey: "sim" } },
        });
        assert.deepEqual(record.simulator, [{ step: 0, turns: 2, endedBy: "until" }]);
        assert.equal(record.turns[1].user.source, "simulator");
    });

    it("notes a close error without changing the outcome", async () => {
        const fake = system(() => ({ reply: "x" }));
        const connection = fake.connect(undefined);
        const record = await play(scenario({ id: "z", steps: [{ user: "a" }] }), fake, {
            connection: {
                ...connection,
                close: async () => {
                    throw new Error("delete failed");
                },
            },
        });
        assert.equal(record.outcome, "passed");
        assert.equal(record.closeError, "delete failed");
    });
});

describe("hardening regressions", () => {
    it("restores bindings after a choose branch shadows them", async () => {
        const fake = system(() => ({ signals: { offered: Offered } }));
        const result = await play(
            scenario({
                id: "shadow",
                steps: [
                    { user: "first" },
                    { user: "outer", bind: { pick: "offered[0]" } },
                    { choose: [{ otherwise: true, bind: { pick: "offered[1]" }, user: "{{pick.label}}" }] },
                    { user: "{{pick.label}}" },
                ],
            }),
            fake
        );
        assert.equal(result.turns[2].user.text, Offered[1].label);
        assert.equal(result.turns[3].user.text, Offered[0].label);
    });

    it("returns a gate failure for dependent steps after immediate simulator stop", async () => {
        for (const dependent of [
            { bind: { pick: "offered[0]" }, user: "{{pick.label}}" },
            { choose: [{ otherwise: true, user: "next" }] },
        ]) {
            const fake = system(() => ({}), {
                complete: () => ({ text: "###STOP###", usage: { inputTokens: 0, outputTokens: 0 } }),
            });
            const result = await play(
                scenario({
                    id: "stop",
                    steps: [{ simulate: { persona: "user", goal: "done", maxTurns: 1 } }, dependent],
                }),
                fake,
                { harness: { judge: null, simulator: Model } }
            );
            assert.equal(result.outcome, "failed");
            assert.equal(result.turns.length, 0);
        }
    });

    it("retains proven safety failure when a later send is aborted", async () => {
        const controller = new AbortController();
        const fake = system((turn) => {
            if (turn === 2) {
                controller.abort();
                return { error: new Error("aborted") };
            }
            return { signals: { emergency: false } };
        });
        const result = await play(
            scenario({
                id: "sticky",
                steps: [
                    { user: "one", expect: [{ severity: "safety", check: { signal: "emergency", is: true } }] },
                    { user: "two" },
                ],
            }),
            fake,
            { keepGoing: true, signal: controller.signal }
        );
        assert.equal(result.safetyMiss, true);
        assert.equal(result.outcome, "failed");
        assert.ok(result.brokenBy);
    });
});

it("bounds never-settling cleanup and keeps the behavior verdict", async () => {
    const fake = system(() => ({}));
    const connection = fake.connect(undefined);
    const result = await play(scenario({ id: "close", steps: [{ user: "hi" }] }), fake, {
        connection: { ...connection, close: () => new Promise(() => {}) },
    });
    assert.equal(result.outcome, "passed");
    assert.match(result.closeError ?? "", /cleanup exceeded/);
});

it("cancels never-settling cleanup promptly", async () => {
    const controller = new AbortController();
    const fake = system(() => ({}));
    const connection = fake.connect(undefined);
    const result = await play(scenario({ id: "close", steps: [{ user: "hi" }] }), fake, {
        signal: controller.signal,
        connection: {
            ...connection,
            close: () => {
                controller.abort();
                return new Promise(() => {});
            },
        },
    });
    assert.equal(result.outcome, "passed");
    assert.match(result.closeError ?? "", /aborted/);
});

it("stops unresolved nested templates before another send", async () => {
    const fake = system(() => ({ signals: { offered: [] } }));
    const result = await play(
        scenario({
            id: "missing",
            steps: [{ user: "hi" }, { bind: { picks: "offered" }, user: "{{picks[0].label}}" }],
        }),
        fake
    );
    assert.equal(result.outcome, "failed");
    assert.equal(fake.log.sent.length, 1);
});

it("returns a deterministic failure for an invalid expanded regex", async () => {
    const fake = system(() => ({ reply: "hello", signals: { offered: [{ label: "(", startsAt: "today" }] } }));
    const result = await play(
        scenario({
            id: "regex",
            steps: [
                { user: "hi" },
                {
                    bind: { pick: "offered[0]" },
                    user: "next",
                    expect: [{ check: { not: { text: { matches: "{{pick.label}}" } } } }],
                },
            ],
        }),
        fake
    );
    assert.equal(result.outcome, "failed");
    assert.equal(result.brokenBy, null);
    assert.equal(fake.log.sent.length, 2);
});

it("restores branch bindings when a branch stops on a gating failure", async () => {
    const fake = system(() => ({ signals: { offered: Offered, emergency: false } }));
    const result = await play(
        scenario({
            id: "branch-stop",
            steps: [
                { user: "first" },
                { user: "outer", bind: { pick: "offered[0]" } },
                {
                    choose: [
                        {
                            otherwise: true,
                            bind: { pick: "offered[1]" },
                            user: "branch",
                            expect: [{ check: { signal: "emergency", is: true } }],
                        },
                    ],
                },
            ],
        }),
        fake
    );
    assert.equal(result.outcome, "failed");
    assert.deepEqual(result.bindings.pick, Offered[0]);
});
