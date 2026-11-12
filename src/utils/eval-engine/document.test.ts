// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/document.test.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
    canonicalJson,
    checkBuilder,
    EvalConfigError,
    evalKit,
    fillCheck,
    fillText,
    parseMatrix,
    parseScenarios,
    resolveBindings,
    type Scenario,
    type ScenarioIssue,
    withAlways,
} from "./document";
import { fakeSystem } from "./testing";

const Signals = z.object({
    offered: z.array(z.object({ label: z.string(), startsAt: z.string() })),
    emergency: z.boolean(),
    booking: z.object({ startsAt: z.string() }).nullable(),
    extra: z.record(z.string(), z.unknown()).optional(),
});
const Setup = z.object({
    locale: z.enum(["cs", "sk"]).default("cs"),
    clock: z.enum(["Real", "MondayMorning"]).default("Real"),
});
const System = fakeSystem({
    tools: ["find_free_slots", "book_appointment", "request_human"],
    setup: Setup,
    signals: Signals,
    defaultSignals: { offered: [], emergency: false, booking: null },
    reply: () => ({ reply: "ok" }),
});
const kit = evalKit(System);

function issuesOf(input: unknown): ScenarioIssue[] {
    const result = parseScenarios(input, System, "stdin");
    assert.equal(result.ok, false, "expected issues");
    return result.ok ? [] : result.issues;
}

function parseOk(input: unknown): Scenario[] {
    const result = parseScenarios(input, System, "stdin");
    if (!result.ok) {
        assert.fail(JSON.stringify(result.issues));
    }
    return result.scenarios;
}

describe("parseScenarios", () => {
    it("fills defaults: title, tags, severity gate, expectation ids, setup defaults", () => {
        const [scenario] = parseOk({
            id: "a",
            steps: [{ user: "hi", expect: [{ check: { tool: "find_free_slots" } }] }],
            always: [{ check: { signal: "emergency", is: false } }],
            final: [{ check: { signal: "booking", exists: true } }],
        });
        assert.equal(scenario.doc.title, "a");
        assert.deepEqual(scenario.doc.tags, []);
        assert.deepEqual(scenario.doc.setup, { locale: "cs", clock: "Real" });
        assert.deepEqual(scenario.doc.steps[0], {
            user: "hi",
            expect: [{ id: "s1.e1", severity: "gate", check: { tool: "find_free_slots" } }],
        });
        assert.equal(scenario.doc.always[0].id, "a1");
        assert.equal(scenario.doc.final[0].id, "f1");
        assert.match(scenario.hash, /^[0-9a-f]{16}$/);
    });

    it("names the path and the known names for an unknown tool", () => {
        const issues = issuesOf([
            {
                id: "a",
                steps: [
                    { user: "x", expect: [{ check: { tool: "find_free_slots" } }, { check: { tool: "find_slots" } }] },
                ],
            },
        ]);
        assert.deepEqual(issues, [
            {
                path: "0.steps.0.expect.1.check.tool",
                message: 'unknown tool "find_slots"; known: find_free_slots, book_appointment, request_human',
            },
        ]);
    });

    it("checks signal paths deep into the zod object, with the known names", () => {
        const issues = issuesOf({
            id: "a",
            steps: [{ user: "x", expect: [{ check: { signal: "booking.startAt", exists: true } }] }],
        });
        assert.equal(issues[0].path, "steps.0.expect.0.check.signal");
        assert.match(issues[0].message, /booking has no field "startAt"; known: startsAt/);
        assert.match(
            issuesOf({
                id: "a",
                steps: [{ user: "x", expect: [{ check: { signal: "offerd", size: { min: 1 } } }] }],
            })[0].message,
            /unknown signal "offerd"; known: offered, emergency, booking, extra/
        );
        assert.match(
            issuesOf({ id: "a", steps: [{ user: "x", expect: [{ check: { signal: "offered.label", is: "x" } }] }] })[0]
                .message,
            /offered is a list; use offered\[n\]/
        );
        assert.match(
            issuesOf({ id: "a", steps: [{ user: "x", expect: [{ check: { signal: "emergency.x", is: 1 } }] }] })[0]
                .message,
            /emergency is a single value/
        );
        parseOk({
            id: "a",
            steps: [
                {
                    user: "x",
                    expect: [
                        { check: { signal: "offered[1].label", is: "x" } },
                        { check: { signal: "extra.anything.deep", exists: true } },
                    ],
                },
            ],
        });
    });

    it("checks bind paths and template paths against the signals", () => {
        const steps = (bind: string, text: string) => [{ user: "a" }, { bind: { pick: bind }, user: text }];
        parseOk({ id: "a", steps: steps("offered[1]", "take {{pick.label}}") });
        assert.match(
            issuesOf({ id: "a", steps: steps("offered[1]", "take {{pick.lable}}") })[0].message,
            /has no field "lable"; known: label, startsAt/
        );
        assert.match(issuesOf({ id: "a", steps: steps("offerd[1]", "x") })[0].message, /unknown signal "offerd"/);
        assert.match(
            issuesOf({ id: "a", steps: [{ user: "a {{pick.label}}" }] })[0].message,
            /reads "pick", which no earlier bind makes/
        );
        assert.equal(
            issuesOf({ id: "a", steps: [{ bind: { pick: "offered[0]" }, user: "a" }] })[0].path,
            "steps.0.bind"
        );
    });

    it("refuses a judge under safety, in choose.when and in simulate.until, with its path", () => {
        const judgeInSafety = issuesOf({
            id: "a",
            steps: [
                {
                    user: "x",
                    expect: [
                        {
                            id: "s",
                            severity: "safety",
                            check: { anyOf: { code: { tool: "request_human" }, model: { judge: "Is it calm?" } } },
                        },
                    ],
                },
            ],
        });
        assert.deepEqual(judgeInSafety, [
            {
                path: "steps.0.expect.0.check.anyOf.model.judge",
                message: "a safety expectation takes only checks that code decides; a judge is not allowed here",
            },
        ]);
        const inWhen = issuesOf({
            id: "a",
            steps: [
                { user: "x" },
                {
                    choose: [
                        { when: { judge: "q" }, user: "y" },
                        { otherwise: true, user: "z" },
                    ],
                },
            ],
        });
        assert.equal(inWhen[0].path, "steps.1.choose.0.when.judge");
        const inUntil = issuesOf({
            id: "a",
            steps: [{ simulate: { persona: "p", goal: "g", maxTurns: 3, until: { not: { judge: "q" } } } }],
        });
        assert.equal(inUntil[0].path, "steps.0.simulate.until.not.judge");
    });

    it("refuses unknown keys, two matchers, a bad regex and duplicate ids", () => {
        assert.ok(
            issuesOf({ id: "a", steps: [{ user: "x" }], stpes: [] }).some((i) => /Unrecognized key/.test(i.message))
        );
        assert.match(
            issuesOf({
                id: "a",
                steps: [{ user: "x", expect: [{ check: { signal: "emergency", is: true, exists: true } }] }],
            })[0].message,
            /exactly one matcher/
        );
        assert.match(
            issuesOf({ id: "a", steps: [{ user: "x", expect: [{ check: { text: { matches: "(" } } }] }] })[0].message,
            /not a regular expression/
        );
        assert.match(
            issuesOf({
                id: "a",
                steps: [
                    {
                        user: "x",
                        expect: [
                            { id: "e", check: { tool: "find_free_slots" } },
                            { id: "e", check: { tool: "find_free_slots" } },
                        ],
                    },
                ],
            })[0].message,
            /"e" is used twice/
        );
        assert.match(
            issuesOf([
                { id: "a", steps: [{ user: "x" }] },
                { id: "a", steps: [{ user: "y" }] },
            ])[0].message,
            /scenario id "a" is used twice/
        );
    });

    it("names anyOf branches given as a list 1, 2, …", () => {
        const [scenario] = parseOk({
            id: "a",
            steps: [
                { user: "x", expect: [{ check: { anyOf: [{ tool: "find_free_slots" }, { tool: "request_human" }] } }] },
            ],
        });
        const step = scenario.doc.steps[0];
        assert.ok("user" in step);
        assert.deepEqual(step.expect?.[0].check, {
            anyOf: { "1": { tool: "find_free_slots" }, "2": { tool: "request_human" } },
        });
    });

    it("validates choose: not first, otherwise last, branch names", () => {
        assert.match(
            issuesOf({ id: "a", steps: [{ choose: [{ otherwise: true, user: "x" }] }] })[0].message,
            /first step has no previous turn/
        );
        assert.match(
            issuesOf({
                id: "a",
                steps: [
                    { user: "x" },
                    {
                        choose: [
                            { otherwise: true, user: "y" },
                            { when: { tool: "find_free_slots" }, user: "z" },
                        ],
                    },
                ],
            })[0].message,
            /"otherwise" must be the last/
        );
        const [scenario] = parseOk({
            id: "a",
            steps: [
                { user: "x" },
                {
                    choose: [
                        { when: { onlyTools: [] }, user: "a" },
                        { otherwise: true, user: "b" },
                    ],
                },
            ],
        });
        const choose = scenario.doc.steps[1];
        assert.ok("choose" in choose);
        assert.deepEqual(
            choose.choose.map((b) => b.name),
            ["1", "otherwise"]
        );
    });

    it("keeps bindings of a choose branch inside that branch", () => {
        const issues = issuesOf({
            id: "a",
            steps: [
                { user: "x" },
                {
                    choose: [
                        { when: { onlyTools: [] }, bind: { pick: "offered[0]" }, user: "{{pick.label}}" },
                        { otherwise: true, user: "b" },
                    ],
                },
                { user: "{{pick.label}}" },
            ],
        });
        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, "steps.2.user");
    });
});

describe("hash and builder", () => {
    it("is stable under key order", () => {
        const [a] = parseOk({
            id: "a",
            tags: ["t"],
            steps: [{ user: "x", expect: [{ id: "e", severity: "gate", check: { signal: "emergency", is: false } }] }],
        });
        const [b] = parseOk({
            steps: [{ expect: [{ check: { is: false, signal: "emergency" }, severity: "gate", id: "e" }], user: "x" }],
            tags: ["t"],
            id: "a",
        });
        assert.equal(a.hash, b.hash);
        assert.equal(canonicalJson({ b: 1, a: { d: 1, c: undefined } }), '{"a":{"d":1},"b":1}');
    });

    it("the builder gives the same document as the JSON form", () => {
        const built = kit.defineEvalScenario({
            id: "toothache",
            tags: ["regression"],
            setup: { clock: "MondayMorning" },
            steps: (s) => [
                {
                    user: "Bolí mě zub.",
                    expect: [
                        s.safety("no-emergency", s.signal("emergency", { is: false })),
                        s.gate(
                            "offers-or-asks",
                            s.anyOf({
                                offers: s.allOf(s.tool("find_free_slots"), s.signal("offered", { size: { min: 2 } })),
                                asks: s.allOf(s.noTools(), s.judge("Asks when.")),
                            })
                        ),
                    ],
                },
            ],
        });
        const [json] = parseOk({
            id: "toothache",
            tags: ["regression"],
            setup: { clock: "MondayMorning" },
            steps: [
                {
                    user: "Bolí mě zub.",
                    expect: [
                        { id: "no-emergency", severity: "safety", check: { signal: "emergency", is: false } },
                        {
                            id: "offers-or-asks",
                            check: {
                                anyOf: {
                                    offers: {
                                        allOf: [{ tool: "find_free_slots" }, { signal: "offered", size: { min: 2 } }],
                                    },
                                    asks: { allOf: [{ onlyTools: [] }, { judge: "Asks when." }] },
                                },
                            },
                        },
                    ],
                },
            ],
        });
        assert.equal(built.hash, json.hash);
        assert.equal(built.origin, "file");
    });

    it("type-checks safety, tool names and signal names", () => {
        const s = kit.check;
        s.safety("ok", s.anyOf({ a: s.tool("request_human"), b: s.not(s.signal("emergency", { is: true })) }));
        // @ts-expect-error a judge under safety does not compile
        s.safety("no", s.judge("Is it calm?"));
        // @ts-expect-error a judge inside an any-of under safety does not compile either
        s.safety("no", s.anyOf({ a: s.tool("request_human"), b: s.judge("q") }));
        // @ts-expect-error an unknown tool
        s.tool("find_slots");
        // @ts-expect-error an unknown signal
        s.signal("offerd", { exists: true });
        s.signal("offered[1].label", { is: "x" });
        assert.ok(true);
    });

    it("throws EvalConfigError with every issue from defineEvalScenario", () => {
        assert.throws(
            () =>
                kit.defineEvalScenario({
                    id: "bad",
                    steps: [{ user: "x", expect: [{ id: "e", severity: "gate", check: { tool: "nope" } }] }],
                }),
            (error: unknown) =>
                error instanceof EvalConfigError &&
                error.code === "invalid-scenario" &&
                error.issues[0].path === "steps.0.expect.0.check.tool"
        );
    });

    it("appends the project's always list into the document and the hash", () => {
        const base = kit.defineEvalScenario({ id: "a", steps: [{ user: "x" }] });
        const always = [
            checkBuilder<"request_human", "emergency">().gate("engine", { signal: "emergency", is: false }),
        ];
        const merged = withAlways(base, always, System);
        assert.notEqual(merged.hash, base.hash);
        assert.deepEqual(
            merged.doc.always.map((e) => e.id),
            ["engine"]
        );
        const clash = kit.defineEvalScenario({
            id: "b",
            steps: [{ user: "x" }],
            always: (s) => [s.gate("engine", s.noTools())],
        });
        assert.throws(() => withAlways(clash, always, System), /invalid-scenario|always list/);
    });
});

describe("bindings and templates", () => {
    const signals = {
        offered: [
            { label: "Po 8:00", startsAt: "2026-11-16T07:00:00Z" },
            { label: "Po 9:00", startsAt: "2026-11-16T08:00:00Z" },
        ],
        count: 2,
    };

    it("resolves a path or says why not", () => {
        assert.deepEqual(resolveBindings({ pick: "offered[1]" }, signals), {
            ok: true,
            values: { pick: signals.offered[1] },
        });
        assert.deepEqual(resolveBindings({ pick: "offered[2]" }, signals), {
            ok: false,
            name: "pick",
            path: "offered[2]",
            reason: "needed offered[2]; offered has 2 items, no [2]",
        });
    });

    it("fills texts and checks; a whole template keeps the value's type", () => {
        const bindings = { pick: signals.offered[1], n: 2 };
        assert.equal(fillText("Take {{pick.label}} ({{ n }})", bindings), "Take Po 9:00 (2)");
        assert.deepEqual(
            fillCheck(
                { tool: "book_appointment", args: { starts_at: { instant: "{{pick.startsAt}}" }, count: "{{n}}" } },
                bindings
            ),
            {
                tool: "book_appointment",
                args: { starts_at: { instant: "2026-11-16T08:00:00Z" }, count: 2 },
            }
        );
    });
});

describe("matrices", () => {
    it("validates a matrix", () => {
        assert.equal(
            parseMatrix({ id: "m", scenarios: { tags: ["x"] }, models: ["fake"], repeats: 2, maxCostUsd: 1 }).repeats,
            2
        );
        assert.throws(
            () => kit.defineEvalMatrix({ id: "m", scenarios: "all", models: [], repeats: 0 }),
            (e: unknown) => e instanceof EvalConfigError && e.code === "invalid-matrix"
        );
    });
});
