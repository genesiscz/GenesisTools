// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/evaluate.test.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Check } from "./document";
import {
    conversationOutcome,
    type ExpectationVerdict,
    evaluateCheck,
    evaluateExpectations,
    type JudgeAnswer,
    type JudgeRequest,
    matchValue,
    type Scope,
} from "./evaluate";

function scope(overrides: Partial<Scope> = {}): Scope {
    return {
        kind: "turn",
        turn: 1,
        toolCalls: [
            { name: "find_free_slots", input: { day: "2026-11-16" } },
            { name: "book_appointment", input: { starts_at: "2026-11-16T09:00:00+01:00" } },
        ],
        toolEvidence: "observed",
        replies: ["Mám volno v pondělí v 9:00."],
        signals: { offered: [{ label: "Po 9:00" }, { label: "Po 10:00" }], emergency: false, booking: null },
        transcript: [{ role: "user", text: "Bolí mě zub.", toolCalls: [] }],
        ...overrides,
    };
}

const none = new Map<string, JudgeAnswer>();
const result = (check: Check, s: Scope = scope(), answers = none) => evaluateCheck(check, s, answers).verdict.result;

describe("evaluateCheck", () => {
    it("counts tool calls with matching arguments and times", () => {
        assert.equal(result({ tool: "find_free_slots" }), "pass");
        assert.equal(result({ tool: "request_human" }), "fail");
        assert.equal(
            result({ tool: "book_appointment", args: { starts_at: { instant: "2026-11-16T08:00:00Z" } } }),
            "pass"
        );
        const miss = evaluateCheck(
            { tool: "book_appointment", args: { starts_at: { instant: "2026-11-16T10:00:00Z" } } },
            scope(),
            none
        ).verdict;
        assert.equal(miss.result, "fail");
        assert.match(
            miss.reason,
            /starts_at is "2026-11-16T09:00:00\+01:00", expected the instant 2026-11-16T10:00:00.000Z/
        );
        assert.equal(result({ tool: "find_free_slots", times: { max: 0 } }), "fail");
        assert.equal(result({ tool: "request_human", times: { min: 0, max: 0 } }), "pass");
        assert.equal(result({ tool: "find_free_slots", args: { day: "2026-11-16" } }), "pass");
    });

    it("is inconclusive on tool checks when tool calls were not observable", () => {
        const blind = scope({ toolEvidence: "unavailable" });
        assert.equal(result({ tool: "find_free_slots" }, blind), "inconclusive");
        assert.equal(result({ onlyTools: [] }, blind), "inconclusive");
    });

    it("checks onlyTools, text and signals", () => {
        assert.equal(result({ onlyTools: [] }), "fail");
        assert.equal(result({ onlyTools: ["find_free_slots", "book_appointment"] }), "pass");
        assert.equal(result({ text: { contains: "PONDĚLÍ" } }), "pass");
        assert.equal(result({ text: { contains: "PONDĚLÍ", caseSensitive: true } }), "fail");
        assert.equal(result({ text: { matches: "\\b9:00" } }), "pass");
        assert.equal(result({ signal: "offered", size: { min: 2 } }), "pass");
        assert.equal(result({ signal: "offered[1].label", is: "Po 10:00" }), "pass");
        assert.equal(result({ signal: "offered[2].label", exists: false }), "pass");
        assert.equal(result({ signal: "booking", exists: false }), "pass");
        assert.equal(result({ signal: "emergency", oneOf: [true] }), "fail");
        const missing = evaluateCheck({ signal: "offered[5].label", is: "x" }, scope(), none).verdict;
        assert.match(missing.reason, /offered has 2 items, no \[5\]/);
    });

    it("names the branch of an any-of that passed", () => {
        const { verdict } = evaluateCheck(
            { anyOf: { asks: { onlyTools: [] }, offers: { tool: "find_free_slots" } } },
            scope(),
            none
        );
        assert.equal(verdict.result, "pass");
        assert.equal(verdict.branch, "offers");
        assert.match(verdict.reason, /^branch offers passed/);
    });

    it("asks no judge when a code branch passes or a code child fails", () => {
        const passing = evaluateCheck(
            { anyOf: { offers: { tool: "find_free_slots" }, asks: { judge: "Does it ask?" } } },
            scope(),
            none
        );
        assert.equal(passing.verdict.result, "pass");
        assert.deepEqual(passing.needs, []);
        const failing = evaluateCheck({ allOf: [{ tool: "request_human" }, { judge: "Is it kind?" }] }, scope(), none);
        assert.equal(failing.verdict.result, "fail");
        assert.deepEqual(failing.needs, []);
        const open = evaluateCheck({ allOf: [{ tool: "find_free_slots" }, { judge: "Is it kind?" }] }, scope(), none);
        assert.equal(open.verdict.result, "inconclusive");
        assert.equal(open.needs.length, 1);
    });

    it("keeps inconclusive through not, and flips pass and fail", () => {
        assert.equal(result({ not: { tool: "request_human" } }), "pass");
        assert.equal(result({ not: { judge: "x" } }), "inconclusive");
    });
});

describe("matchValue", () => {
    it("compares instants whatever the ISO spelling", () => {
        assert.equal(matchValue("2026-11-16T09:00:00+01:00", { instant: "2026-11-16T08:00:00.000Z" }).ok, true);
        assert.equal(matchValue(5, { min: 1, max: 4 }).ok, false);
        assert.equal(matchValue(undefined, { exists: false }).ok, true);
        assert.equal(matchValue(undefined, { is: null }).ok, false);
    });
});

describe("evaluateExpectations", () => {
    const judgeOn = (answer: Omit<JudgeAnswer, "usage">) => {
        const asked: JudgeRequest[] = [];
        const ask = async (request: JudgeRequest): Promise<JudgeAnswer> => {
            asked.push(request);
            return { ...answer, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 } };
        };
        return { asked, ask };
    };

    it("asks each open judge question once and records the passing branch", async () => {
        const judge = judgeOn({ result: "pass", reason: "it asks once" });
        const { verdicts, judgeUsage } = await evaluateExpectations(
            [
                {
                    expectation: {
                        id: "a",
                        severity: "gate",
                        check: {
                            anyOf: {
                                offers: { tool: "request_human" },
                                asks: { allOf: [{ tool: "find_free_slots" }, { judge: "Asks once?" }] },
                            },
                        },
                    },
                    place: "turn",
                },
                { expectation: { id: "b", severity: "advisory", check: { judge: "Asks once?" } }, place: "turn" },
            ],
            scope(),
            {},
            judge.ask
        );
        assert.equal(judge.asked.length, 1);
        assert.deepEqual(
            verdicts.map((v) => [v.id, v.result, v.branch]),
            [
                ["a", "pass", "asks"],
                ["b", "pass", null],
            ]
        );
        assert.equal(judgeUsage.costUsd, 0.001);
    });

    it("fills bindings before evaluating and stores the filled check", async () => {
        const { verdicts } = await evaluateExpectations(
            [
                {
                    expectation: {
                        id: "x",
                        severity: "gate",
                        check: { signal: "offered[1].label", is: "{{pick.label}}" },
                    },
                    place: "turn",
                },
            ],
            scope(),
            { pick: { label: "Po 10:00" } },
            judgeOn({ result: "pass", reason: "" }).ask
        );
        assert.equal(verdicts[0].result, "pass");
        assert.deepEqual(verdicts[0].check, { signal: "offered[1].label", is: "Po 10:00" });
    });

    it("a judge that cannot tell makes the verdict inconclusive, never a pass", async () => {
        const { verdicts } = await evaluateExpectations(
            [{ expectation: { id: "x", severity: "gate", check: { judge: "?" } }, place: "turn" }],
            scope(),
            {},
            judgeOn({ result: "inconclusive", reason: "no judge is configured" }).ask
        );
        assert.equal(verdicts[0].result, "inconclusive");
    });
});

describe("conversationOutcome", () => {
    const verdict = (
        severity: ExpectationVerdict["severity"],
        result: ExpectationVerdict["result"],
        turn = 1
    ): ExpectationVerdict => ({
        id: `${severity}-${turn}`,
        severity,
        place: "turn",
        turn,
        result,
        reason: "",
        check: null,
        branch: null,
        tree: { label: "x", result, reason: "" },
    });

    it("never lifts an earlier safety failure with a later pass", () => {
        const outcome = conversationOutcome(
            [verdict("safety", "fail", 1), verdict("safety", "pass", 2), verdict("gate", "pass", 2)],
            true
        );
        assert.deepEqual(outcome, { outcome: "failed", safetyMiss: true, safetyUnverified: false });
    });

    it("keeps a proven failure when the conversation broke later, and says nothing otherwise", () => {
        assert.equal(conversationOutcome([verdict("gate", "fail")], false)?.outcome, "failed");
        assert.equal(conversationOutcome([verdict("gate", "pass")], false), null);
    });

    it("ignores advisory verdicts and marks an undecided safety check", () => {
        assert.equal(conversationOutcome([verdict("advisory", "fail")], true)?.outcome, "passed");
        assert.deepEqual(conversationOutcome([verdict("safety", "inconclusive")], true), {
            outcome: "inconclusive",
            safetyMiss: false,
            safetyUnverified: true,
        });
    });
});

it("handles invalid expanded regexes deterministically", () => {
    assert.throws(() => result({ text: { matches: "(" } }), /invalid expanded regex/);
    assert.throws(() => matchValue("text", { matches: "(" }), /invalid expanded regex/);
});
