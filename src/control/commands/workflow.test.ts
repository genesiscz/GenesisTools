import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { OperationBudget } from "@genesiscz/utils/operation-budget";
import type { JsonLineTransport } from "@genesiscz/utils/process/json-line-process";
import { ComputerUse } from "../lib/computer-use/session";
import { assistTask } from "../lib/decision/assist";
import { awaitCondition, semanticFingerprint } from "../lib/decision/await";
import { type CalibrationRow, calibrationReport } from "../lib/decision/calibration";
import { acceptHostChoice, chooseCandidate, readHostDecision } from "../lib/decision/chooser";
import { compareChoosers } from "../lib/decision/chooser-replay";
import { admittedChoice, judgeOutcome, resolveIntent } from "../lib/decision/decisions";
import { fillForm } from "../lib/decision/fill";
import { replayCases } from "../lib/decision/fixtures";
import type { ControlDriver } from "../lib/decision/native";
import { NativeControlSession } from "../lib/decision/native-session";
import { candidatesFor, type Observation } from "../lib/decision/observation";
import { NativeObservationSource } from "../lib/decision/observation-source";
import { actionRefusal, authenticationBarrier, RecoveryController } from "../lib/decision/recovery";
import { replayControl } from "../lib/decision/replay";
import { replayResilience } from "../lib/decision/resilience-replay";
import { runNativeSequence } from "../lib/decision/sequence";
import { ControlSession } from "../lib/decision/session";
import { type VisualDriver, visualObservationSchema, visualTask } from "../lib/decision/visual";
import { VisualCaptureStore } from "../lib/decision/visual-store";
import { replayWait, waitCases } from "../lib/decision/wait-replay";
import { applyWorkflowRepairs, attachSemanticPlan, replayWorkflow, type WorkflowPlan } from "../lib/decision/workflow";

const entry = join(import.meta.dir, "..", "index.ts");

test("snapshot inspection exposes its window selection without touching a live app", () => {
    const result = spawnSync("bun", [entry, "see", "--help"], {
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--window-index");
    expect(result.stdout).toContain("--path");
});

test("action help exposes native drag selection and paste options", () => {
    const result = spawnSync("bun", [entry, "act", "--help"], {
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--to");
    expect(result.stdout).toContain("--range");
    expect(result.stdout).toContain("--format");
    expect(result.stdout).toContain("256 UTF-16 units");
    expect(result.stdout).toContain("--button [name]");
});

test("an invalid drag button is rejected before native resolution", () => {
    const result = spawnSync(
        "bun",
        [
            entry,
            "act",
            "--app",
            "nonexistent-control-fixture",
            "--snapshot",
            "invalid",
            "--element",
            "0",
            "--action",
            "drag",
            "--button",
            "middleish",
        ],
        {
            env: process.env,
            encoding: "utf8",
            timeout: 30_000,
        }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--button");
    expect(result.stderr).not.toContain("app not found");
});

test("an unknown action is rejected before app resolution", () => {
    const result = spawnSync(
        "bun",
        [
            entry,
            "act",
            "--app",
            "nonexistent-control-fixture",
            "--snapshot",
            "invalid",
            "--element",
            "0",
            "--action",
            "launch-missiles",
        ],
        {
            env: process.env,
            encoding: "utf8",
            timeout: 30_000,
        }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--action");
    expect(result.stderr).not.toContain("app not found");
});

test("type rejects text over 256 UTF-16 units before native resolution", () => {
    const result = spawnSync(
        "bun",
        [
            entry,
            "act",
            "--app",
            "nonexistent-control-fixture",
            "--snapshot",
            "invalid",
            "--element",
            "0",
            "--action",
            "type",
            "--text",
            "x".repeat(257),
        ],
        {
            env: process.env,
            encoding: "utf8",
            timeout: 30_000,
        }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("256 UTF-16 units");
    expect(result.stderr).toContain("paste");
    expect(result.stderr).not.toContain("app not found");
});
// The one-process door has exactly two ways to be addressed wrongly, and both are cheaper to
// catch here than in the native tool: neither selector, or both of them.
test("act takes a snapshot or an identifier, never both and never neither", () => {
    const run = (args: string[]) =>
        spawnSync("bun", [entry, "act", "--app", "nonexistent-control-fixture", "--action", "press", ...args], {
            env: process.env,
            encoding: "utf8",
            timeout: 30_000,
        });

    const neither = run([]);
    expect(neither.status).toBe(1);
    expect(neither.stderr).toContain("--by-identifier <id> to observe and act in one step");
    expect(neither.stderr).not.toContain("app not found");

    const both = run(["--snapshot", "invalid", "--by-identifier", "focus-hud-primary"]);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("cannot also take a --snapshot token");
    expect(both.stderr).not.toContain("app not found");
});

test("see and act help name the diff and refresh options", () => {
    const see = spawnSync("bun", [entry, "see", "--help"], { env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(see.status).toBe(0);
    expect(see.stdout).toContain("--since <json>");

    const act = spawnSync("bun", [entry, "act", "--help"], { env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(act.status).toBe(0);
    expect(act.stdout).toContain("--refresh");
    expect(act.stdout).toContain("--by-identifier <id>");
    expect(act.stdout).toContain("--path <png>");
});

const semanticFixture: Observation = {
    ok: true,
    app: "Fixture",
    pid: 1,
    window: { id: 1, title: "Fixture" },
    snapshot: "fixture-token",
    scope: "window",
    elements: [
        { index: 0, depth: 0, role: "AXGroup", AXTitle: "Account" },
        {
            index: 1,
            depth: 1,
            role: "AXButton",
            AXTitle: "Settings",
            AXIdentifier: "account-settings",
            actions: ["AXPress"],
            AXEnabled: "1",
        },
        { index: 2, depth: 0, role: "AXGroup", AXTitle: "Project" },
        {
            index: 3,
            depth: 1,
            role: "AXButton",
            AXTitle: "Settings",
            AXIdentifier: "project-settings",
            actions: ["AXPress"],
            AXEnabled: "1",
        },
        { index: 4, depth: 1, role: "AXButton", AXTitle: "Export", actions: ["AXPress"], AXEnabled: "0" },
        { index: 5, depth: 0, role: "AXStaticText", AXIdentifier: "result", AXValue: "Export failed" },
    ],
};
function evaluation(answers: EvaluationResponse["answers"]): EvaluationResponse {
    return {
        model: "fixture",
        answers,
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
    };
}
const chooseFirst: Evaluator = async () =>
    evaluation({
        target: { type: "choice", choice: "c0", probabilities: { c0: 0.96, c1: 0.02, abstain: 0.02 } },
    });
test("candidate context binds unnamed controls to nearby static text without including input values", () => {
    const observation = structuredClone(waitCases[0].frames[0].observation);
    observation.elements = [
        { index: 0, depth: 0, role: "AXGroup" },
        { index: 1, depth: 1, role: "AXCheckBox", actions: ["AXPress"] },
        { index: 2, depth: 1, role: "AXStaticText", AXValue: "First task" },
        { index: 3, depth: 1, role: "AXTextField", AXValue: "private draft" },
        { index: 4, depth: 0, role: "AXGroup" },
        { index: 5, depth: 1, role: "AXCheckBox", actions: ["AXPress"] },
        { index: 6, depth: 1, role: "AXStaticText", AXValue: "Second task" },
    ];
    const candidates = candidatesFor({ observation });
    expect(candidates[0].nearbyText).toEqual(["First task"]);
    expect(candidates[1].nearbyText).toEqual(["Second task"]);
    expect(SafeJSON.stringify(candidates)).not.toContain("private draft");
});
test("semantic resolve retains ancestors, excludes disabled targets and never dispatches", async () => {
    const result = await resolveIntent({
        observation: semanticFixture,
        intent: "Account settings",
        evaluate: chooseFirst,
    });
    expect(result.status).toBe("resolved");
    expect(result.selected?.identifier).toBe("account-settings");
    expect(result.selected?.ancestors).toEqual(["Account"]);
    expect(result.candidates).toHaveLength(2);
    const blocked = structuredClone(semanticFixture);
    blocked.elements[0].AXEnabled = false;
    expect(candidatesFor({ observation: blocked })).toHaveLength(1);
});
test("semantic selection abstains on invented IDs, ambiguous probabilities and bad distributions", () => {
    for (const answer of [
        { type: "choice" as const, choice: "invented", probabilities: { c0: 1, abstain: 0 } },
        { type: "choice" as const, choice: "c0", probabilities: { c0: 0.51, abstain: 0.49 } },
        { type: "choice" as const, choice: "c0", probabilities: { c0: 1.5, abstain: -0.5 } },
    ]) {
        expect(
            admittedChoice({ result: evaluation({ target: answer }), id: "target", allowed: ["c0", "abstain"] })
                .admitted
        ).toBe(false);
    }
});
test("exact verification overrides semantic optimism and does not call the model", async () => {
    const result = await judgeOutcome({
        observation: semanticFixture,
        expect: "Export complete",
        exact: { identifier: "result", value: "Export complete" },
        evaluate: async () => {
            throw new Error("must not call model");
        },
    });
    expect(result.status).toBe("refuted");
    expect(result.basis).toBe("exact");
    expect(result.evidence).toEqual(["e5"]);
});
test("semantic completion requires sufficient evidence and conflicting failure wins", async () => {
    const probabilities = Object.fromEntries([
        ...semanticFixture.elements.map((row) => [`e${row.index}`, row.index === 5 ? 1 : 0]),
        ["none", 0],
    ]);
    const answers = {
        complete: { type: "boolean" as const, probability: 0.99 },
        sufficient: { type: "boolean" as const, probability: 0.99 },
        contradicted: { type: "boolean" as const, probability: 0.99 },
        witness: { type: "choice" as const, choice: "e5", probabilities },
        counterexample: { type: "choice" as const, choice: "e5", probabilities },
    };
    expect(
        (
            await judgeOutcome({
                observation: semanticFixture,
                expect: "Export complete",
                evaluate: async () => evaluation(answers),
            })
        ).status
    ).toBe("refuted");
    expect(
        (
            await judgeOutcome({
                observation: semanticFixture,
                expect: "Export complete",
                evaluate: async () =>
                    evaluation({
                        ...answers,
                        contradicted: { type: "boolean", probability: 0 },
                        sufficient: { type: "boolean", probability: 0.4 },
                    }),
            })
        ).status
    ).toBe("unknown");
});

test("replay oracle verifies plumbing for every case without native actions or model requests", async () => {
    for (const fixture of replayCases) {
        const result = await replayControl({
            input: { fixture, chooser: "mock" },
            evaluate: async () => {
                throw new Error("No network");
            },
        });
        expect(result.metrics).toMatchObject({ correctTarget: true, correctOutcome: true, actions: 0, requests: 0 });
        expect(result.mode).toBe("decision-only");
    }
});
test("replay exact matching exposes semantic misses instead of borrowing fixture labels", async () => {
    const result = await replayControl({ input: { fixture: replayCases[0], chooser: "exact" } });
    expect(result.metrics.correctTarget).toBe(false);
    expect(result.metrics.abstained).toBe(true);
    expect(result.metrics.costUsd).toBe(0);
});

function formDriver(options: { failWrite?: boolean; corruptReadback?: boolean; wrongWindow?: boolean } = {}) {
    let state: Observation = {
        ok: true,
        app: "FormFixture",
        pid: 20,
        window: { id: 30, title: "Profile" },
        snapshot: "s0",
        scope: "window",
        elements: [
            {
                index: 0,
                depth: 0,
                role: "AXTextField",
                AXIdentifier: "name",
                AXTitle: "Full name",
                AXValue: "",
                valueSettable: true,
            },
            {
                index: 1,
                depth: 0,
                role: "AXTextField",
                AXIdentifier: "city",
                AXTitle: "City",
                AXValue: "",
                valueSettable: true,
            },
        ],
    };
    const calls: Array<Parameters<ControlDriver["act"]>[0]> = [];
    let observations = 0;
    const driver: ControlDriver = {
        observe: async () => {
            observations++;
            return structuredClone(state);
        },
        act: async (call) => {
            calls.push(call);
            expect(call.observation.snapshot).toBe(state.snapshot);
            const row = state.elements.find((item) => item.index === call.candidate.element);
            if (row) {
                row.AXValue = options.corruptReadback ? "wrong" : (call.value ?? "1");
            }
            state = {
                ...state,
                snapshot: `s${calls.length}`,
                elements: state.elements.reverse().map((item, index) => ({ ...item, index })),
                window: { ...state.window, id: options.wrongWindow ? 99 : state.window.id },
            };
            return options.failWrite ? { ok: false, error: "Unknown dispatch outcome" } : { ok: true };
        },
    };
    return { driver, calls, observations: () => observations };
}
function chooseField(captured: string[]): Evaluator {
    return async (call) => {
        const input = evaluationSchema.parse(call.input);
        captured.push(SafeJSON.stringify(input));
        const target = input.questions.target;
        if (target.type !== "choice") {
            throw new Error("Expected choice");
        }
        const criteria = Object.keys(target.criteria);
        const choice = criteria.find((key) => key !== "abstain") ?? "abstain";
        return evaluation({
            target: {
                type: "choice",
                choice,
                probabilities: Object.fromEntries(criteria.map((key) => [key, key === choice ? 1 : 0])),
            },
        });
    };
}
test("fill keeps exact values local, reobserves reordered fields and verifies all final values", async () => {
    const fixture = formDriver();
    const captured: string[] = [];
    const result = await fillForm({
        driver: fixture.driver,
        data: { name: "Private Person", city: "Private City" },
        evaluate: chooseField(captured),
    });
    expect(result.status).toBe("filled");
    expect(result.filled.map((field) => field.binding)).toEqual(["id:name", "id:city"]);
    expect(fixture.calls.map((call) => call.value)).toEqual(["Private Person", "Private City"]);
    expect(fixture.observations()).toBe(3);
    expect(captured.join("")).not.toContain("Private Person");
    expect(captured.join("")).not.toContain("Private City");
    expect(fixture.calls.every((call) => call.candidate.action === "set")).toBe(true);
});
test("fill stops after uncertain dispatch, bad readback or window changes without retry", async () => {
    for (const options of [{ failWrite: true }, { corruptReadback: true }, { wrongWindow: true }]) {
        const fixture = formDriver(options);
        const result = await fillForm({
            driver: fixture.driver,
            data: { name: "First", city: "Second" },
            evaluate: chooseField([]),
        });
        expect(result.status).not.toBe("filled");
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.observations()).toBe(2);
    }
});
test("fill respects action/request caps and cancellation before any write", async () => {
    for (const config of [
        { limits: { maxActions: 0 } },
        { limits: { maxRequests: 0 } },
        { signal: AbortSignal.abort() },
    ]) {
        const fixture = formDriver();
        const result = await fillForm({
            driver: fixture.driver,
            data: { name: "First" },
            evaluate: chooseField([]),
            ...config,
        });
        expect(result.status).toBe("stopped");
        expect(fixture.calls).toHaveLength(0);
    }
});

function taskDriver(options: { unknown?: boolean; noChange?: boolean } = {}) {
    let value = "0";
    let calls = 0;
    let observations = 0;
    const driver: ControlDriver = {
        observe: async () => {
            observations++;
            return {
                ok: true,
                app: "TaskFixture",
                pid: 1,
                window: { id: 1, title: "Preferences" },
                snapshot: `s${calls}`,
                scope: "window",
                elements: [
                    {
                        index: 0,
                        depth: 0,
                        role: "AXCheckBox",
                        AXTitle: "Show line numbers",
                        AXIdentifier: "line-numbers",
                        AXValue: value,
                        actions: ["AXPress"],
                    },
                ],
            };
        },
        act: async () => {
            calls++;
            if (!options.noChange) {
                value = "1";
            }
            return options.unknown ? { ok: false, error: "Unknown delivery" } : { ok: true };
        },
    };
    return { driver, calls: () => calls, observations: () => observations };
}
test("assist executes once and finishes only after fresh exact completion", async () => {
    const fixture = taskDriver();
    const result = await assistTask({
        driver: fixture.driver,
        goal: "Enable line numbers",
        exact: { identifier: "line-numbers", value: "1" },
        evaluate: chooseField([]),
        limits: { maxActions: 1, maxRequests: 1 },
    });
    expect(result.status).toBe("verified");
    expect(fixture.calls()).toBe(1);
    expect(fixture.observations()).toBe(2);
    expect(result.metrics).toMatchObject({ actions: 1, requests: 1 });
});
test("assist does not retry uncertain dispatch or a successful no-op", async () => {
    for (const options of [{ unknown: true }, { noChange: true }]) {
        const fixture = taskDriver(options);
        const result = await assistTask({
            driver: fixture.driver,
            goal: "Enable line numbers",
            exact: { identifier: "line-numbers", value: "1" },
            evaluate: chooseField([]),
        });
        expect(result.status).not.toBe("verified");
        expect(fixture.calls()).toBe(1);
        expect(fixture.observations()).toBe(2);
    }
});
test("assist stops on exhausted budgets and cancelled evaluation", async () => {
    for (const config of [
        { limits: { maxActions: 0 } },
        { limits: { maxRequests: 0 } },
        { signal: AbortSignal.abort() },
    ]) {
        const fixture = taskDriver();
        const result = await assistTask({
            driver: fixture.driver,
            goal: "Enable line numbers",
            exact: { identifier: "line-numbers", value: "1" },
            evaluate: chooseField([]),
            ...config,
        });
        expect(result.status).toBe("stopped");
        expect(fixture.calls()).toBe(0);
    }
    const fixture = taskDriver();
    const controller = new AbortController();
    const cancelled = await assistTask({
        driver: fixture.driver,
        goal: "Enable line numbers",
        exact: { identifier: "line-numbers", value: "1" },
        signal: controller.signal,
        evaluate: async (call) => {
            controller.abort();
            return chooseField([])(call);
        },
    });
    expect(cancelled.status).toBe("stopped");
    expect(fixture.calls()).toBe(0);
});

test("assist does not reverse a toggle when semantic completion stays uncertain", async () => {
    const fixture = taskDriver();
    const evaluate: Evaluator = async (call) => {
        const request = evaluationSchema.parse(call.input);
        if (request.questions.target) {
            return chooseField([])(call);
        }
        return evaluation({
            complete: { type: "boolean", probability: 0.7 },
            sufficient: { type: "boolean", probability: 0.7 },
            contradicted: { type: "boolean", probability: 0 },
            witness: { type: "choice", choice: "e0", probabilities: { e0: 1, none: 0 } },
            counterexample: { type: "choice", choice: "none", probabilities: { e0: 0, none: 1 } },
        });
    };
    const result = await assistTask({ driver: fixture.driver, goal: "Enable line numbers", evaluate });
    expect(result.status).toBe("stopped");
    expect(result.reason).toContain("No second toggle");
    expect(fixture.calls()).toBe(1);
});

function sessionFixture(options: { reply?: Record<string, unknown>; evaluate?: Evaluator } = {}) {
    const requests: Record<string, unknown>[] = [];
    let generation = 0;
    let closed = false;
    const transport: JsonLineTransport = {
        request: async ({ input, signal }) => {
            signal?.throwIfAborted();
            requests.push(input);
            if (input.op === "observe") {
                generation++;
                return {
                    ok: true,
                    pid: 1,
                    windowId: 2,
                    scope: "chrome",
                    rootRole: "AXTabGroup",
                    targets: ["one", "two"].map((label, index) => ({
                        id: `${generation}:${index}`,
                        role: "AXRadioButton",
                        roleDescription: "tab",
                        subrole: "AXTabButton",
                        label,
                        selected: index === 0,
                        actions: ["press"],
                    })),
                };
            }
            return options.reply ?? { ok: true, verified: true };
        },
        close: () => {
            closed = true;
        },
    };
    const session = new NativeControlSession({
        app: "Fixture",
        transport,
        evaluate: options.evaluate ?? (async () => evaluation({ matches: { type: "boolean", probability: 0.98 } })),
    });
    return { session, requests, closed: () => closed };
}
test("generic session retains targets and one evaluator across bounded native actions", async () => {
    const fixture = sessionFixture();
    const view = await fixture.session.observe({ role: "AXRadioButton", rootRole: "AXTabGroup" });
    const plan = await fixture.session.chooseAll("Select every tab");
    expect(plan.targets).toEqual(view.targets.map((target) => target.id));
    await fixture.session.batch({
        steps: plan.targets.map((target) => ({ target, verifyAttribute: "AXSelected", verifyValue: true })),
    });
    expect(fixture.requests.map((request) => request.op)).toEqual(["observe", "batch"]);
    fixture.session.close();
    expect(fixture.closed()).toBe(true);
});
test("generic session rejects invented, expired and malformed batch targets before dispatch", async () => {
    const fixture = sessionFixture();
    const old = await fixture.session.observe({ role: "AXButton", rootRole: "AXGroup" });
    await fixture.session.observe({ role: "AXButton", rootRole: "AXGroup" });
    for (const target of ["invented", old.targets[0].id]) {
        await expect(fixture.session.batch({ steps: [{ target }] })).rejects.toThrow("observed");
        await expect(fixture.session.act({ target })).rejects.toThrow("observed");
    }
    expect(fixture.requests).toHaveLength(2);
    fixture.session.close();
});
test("generic session does not dispatch on a low target match or repeat an uncertain mutation", async () => {
    const low = sessionFixture({
        evaluate: async () => evaluation({ matches: { type: "boolean", probability: 0.4 } }),
    });
    await low.session.observe({ role: "AXButton", rootRole: "AXGroup" });
    await expect(low.session.chooseAll("Click save")).rejects.toThrow("did not admit");
    expect(low.requests).toHaveLength(1);
    low.session.close();
    const uncertain = sessionFixture({ reply: { ok: false, dispatchState: "uncertain", error: "delivery lost" } });
    const view = await uncertain.session.observe({ role: "AXButton", rootRole: "AXGroup" });
    const result = await uncertain.session.batch({ steps: [{ target: view.targets[0].id }] });
    expect(result.ok).toBe(false);
    expect(uncertain.requests.map((request) => request.op)).toEqual(["observe", "batch"]);
    uncertain.session.close();
});
test("a new observation invalidates an in-flight semantic choice", async () => {
    let finish!: (result: EvaluationResponse) => void;
    const fixture = sessionFixture({
        evaluate: () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    });
    await fixture.session.observe({ role: "AXButton", rootRole: "AXGroup" });
    const choice = fixture.session.chooseAll("Click save");
    await Promise.resolve();
    await fixture.session.observe({ role: "AXButton", rootRole: "AXGroup" });
    finish(evaluation({ matches: { type: "boolean", probability: 0.99 } }));
    await expect(choice).rejects.toThrow("changed");
    fixture.session.close();
});

test("semantic wait replay calls only for changed evidence and terminates on supported states", async () => {
    for (const [id, status, requests] of [
        ["ready", "ready", 2],
        ["blocked", "blocked", 2],
        ["failed", "failed", 2],
        ["unchanged", "expired", 1],
    ] as const) {
        const result = await replayWait({ input: { id, chooser: "oracle" } });
        expect(result.status).toBe(status);
        expect(result.metrics.requests).toBe(requests);
        expect(result.metrics.actions).toBe(0);
        expect(result.paidRequests).toBe(0);
        if (id === "unchanged") {
            expect(result.metrics.elapsedMs).toBe(4000);
            expect(result.metrics.unchanged).toBe(3);
            expect(result.reason).toContain("no observed progress");
        }
    }
});
test("scoped semantic waits ignore unrelated changing text and stop if their container disappears", async () => {
    for (const removeScope of [false, true]) {
        let time = 0;
        let calls = 0;
        let frames = 0;
        const base = waitCases[0].frames[0].observation;
        const frame = (): Observation => ({
            ...base,
            elements: [
                ...(!removeScope || frames < 2
                    ? [
                          { index: 0, depth: 0, role: "AXGroup", AXIdentifier: "export" },
                          {
                              index: 1,
                              depth: 1,
                              role: "AXStaticText",
                              AXValue: frames >= 3 ? "Export complete" : "Loading",
                          },
                      ]
                    : []),
                { index: 2, depth: 0, role: "AXGroup", AXIdentifier: "clock" },
                { index: 3, depth: 1, role: "AXStaticText", AXValue: `Unrelated clock ${frames}` },
            ],
        });
        const result = await awaitCondition({
            condition: "Export complete",
            evidenceScope: { identifier: "export" },
            driver: {
                observe: async () => frame(),
                act: async () => {
                    throw new Error("No actions in a wait");
                },
            },
            source: {
                kind: "virtual",
                next: async () => {
                    time += 500;
                    frames++;
                    return frame();
                },
            },
            clock: {
                now: () => time,
                sleep: async (ms) => {
                    time += ms;
                },
            },
            limits: { timeoutMs: 3000, maxRequests: 2 },
            evaluate: async (call) => {
                calls++;
                expect(SafeJSON.stringify(call.input)).not.toContain("Unrelated clock");
                return evaluation({
                    ready: { type: "boolean", probability: frames >= 3 ? 1 : 0 },
                    failed: { type: "boolean", probability: 0 },
                    blocked: { type: "boolean", probability: 0 },
                    loading: { type: "boolean", probability: frames >= 3 ? 0 : 1 },
                    evidence: { type: "choice", choice: "e1", probabilities: { e0: 0, e1: 1, none: 0 } },
                });
            },
        });
        expect(result.status).toBe(removeScope ? "stopped" : "ready");
        expect(calls).toBe(removeScope ? 1 : 2);
        if (removeScope) {
            expect(result.reason).toContain("scope is missing");
        } else {
            expect(result.metrics.unchanged).toBe(2);
        }
    }
});
test("exact waits wake on attribute changes with zero model calls and preserve scope checks", async () => {
    for (const changedScope of [false, true]) {
        const first = structuredClone(waitCases[0].frames[0].observation);
        first.elements = [{ index: 0, depth: 0, role: "AXCheckBox", AXIdentifier: "toggle", AXSelected: false }];
        let time = 0;
        let closed = false;
        let wakes = 0;
        const result = await awaitCondition({
            condition: "Toggle selected",
            exact: { identifier: "toggle", attribute: "AXSelected", value: "true" },
            limits: { maxRequests: 0, timeoutMs: 2000 },
            clock: {
                now: () => time,
                sleep: async (ms) => {
                    time += ms;
                },
            },
            driver: {
                observe: async () => first,
                act: async () => {
                    throw new Error("Wait cannot act");
                },
            },
            source: {
                kind: "fixture",
                next: async () => {
                    time += 500;
                    wakes++;
                    return {
                        ...first,
                        pid: changedScope ? first.pid + 1 : first.pid,
                        elements: [{ ...first.elements[0], AXSelected: wakes > 1 }],
                    };
                },
                close: async () => {
                    closed = true;
                },
            },
            evaluate: async () => {
                throw new Error("Exact wait must not call Jev");
            },
        });
        expect(result.status).toBe(changedScope ? "stopped" : "ready");
        expect(result.metrics.requests).toBe(0);
        expect(result.metrics.actions).toBe(0);
        expect(closed).toBe(true);
        if (!changedScope) {
            expect(result.metrics.unchanged).toBe(1);
            expect(result.events.map((event) => event.basis)).toEqual(["exact", "exact"]);
            expect(result.events.at(-1)?.probabilities).toBeNull();
        }
    }
});
test("semantic fingerprints ignore geometry and indexes while preserving meaningful values", () => {
    const first = waitCases[0].frames[0].observation;
    const moved = structuredClone(first);
    moved.elements[0].index = 99;
    moved.elements[0].x = 400;
    moved.snapshot = "new-capture";
    expect(semanticFingerprint(first)).toBe(semanticFingerprint(moved));
    moved.elements[0].AXValue = "Export failed";
    expect(semanticFingerprint(first)).not.toBe(semanticFingerprint(moved));
});
test("wait scope changes and cancellation stop before another model call and close the source", async () => {
    const first = waitCases[0].frames[0].observation;
    for (const signal of [undefined, AbortSignal.abort()]) {
        let closed = false;
        let requests = 0;
        let time = 0;
        const result = await awaitCondition({
            condition: "Export complete",
            signal,
            clock: {
                now: () => time,
                sleep: async (ms) => {
                    time += ms;
                },
            },
            driver: {
                observe: async () => first,
                act: async () => {
                    throw new Error("No mutations");
                },
            },
            source: {
                kind: "fixture",
                next: async () => ({ ...first, pid: 2 }),
                close: async () => {
                    closed = true;
                },
            },
            evaluate: async () => {
                requests++;
                return evaluation({
                    loading: { type: "boolean", probability: 1 },
                    evidence: { type: "choice", choice: "e0", probabilities: { e0: 1, none: 0 } },
                });
            },
        });
        expect(result.status).toBe(signal ? "cancelled" : "stopped");
        expect(requests).toBe(signal ? 0 : 1);
        expect(closed).toBe(true);
    }
});
test("wait respects the model request budget before classifying another frame", async () => {
    const first = waitCases[0].frames[0].observation;
    const result = await awaitCondition({
        condition: "Export complete",
        limits: { maxRequests: 0 },
        driver: {
            observe: async () => first,
            act: async () => {
                throw new Error("No mutations");
            },
        },
        evaluate: async () => {
            throw new Error("Budget must prevent the provider call");
        },
    });
    expect(result.status).toBe("stopped");
    expect(result.metrics.requests).toBe(0);
    expect(result.reason).toContain("request budget");
});

const recoverByReobserving: Evaluator = async (call) => {
    const input = evaluationSchema.parse(call.input);
    if (!input.questions.remedy) {
        return chooseField([])(call);
    }
    const question = input.questions.remedy;
    if (question.type !== "choice") {
        throw new Error("Expected remedy choice");
    }
    return evaluation({
        remedy: {
            type: "choice",
            choice: "reobserve",
            probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((id) => [id, id === "reobserve" ? 1 : 0])
            ),
        },
    });
};
test("bounded recovery redecides a stale action using fresh observation and shared budgets", async () => {
    const fixture = taskDriver();
    let attempts = 0;
    const dispatch = fixture.driver.act;
    const tokens: string[] = [];
    fixture.driver.act = async (call) => {
        attempts++;
        tokens.push(call.observation.snapshot);
        if (attempts === 1) {
            return { ok: false, error: "Stale", dispatchState: "not_started", refusal: "stale_observation" };
        }
        return dispatch(call);
    };
    const observe = fixture.driver.observe;
    fixture.driver.observe = async (call) => ({
        ...(await observe(call)),
        snapshot: `generation-${fixture.observations()}`,
    });
    const result = await assistTask({
        driver: fixture.driver,
        goal: "Enable line numbers",
        exact: { identifier: "line-numbers", value: "1" },
        evaluate: recoverByReobserving,
        recovery: { mode: "bounded" },
    });
    expect(result.status).toBe("verified");
    expect(result.recoveries[0]).toMatchObject({
        category: "stale_observation",
        selected: "reobserve",
        status: "continued",
    });
    expect(attempts).toBe(2);
    expect(fixture.calls()).toBe(1);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(result.metrics).toMatchObject({ actions: 2, requests: 3 });
});
test("uncertain or partial delivery never receives a second dispatch even with recovery enabled", async () => {
    const fixture = taskDriver({ unknown: true });
    const result = await assistTask({
        driver: fixture.driver,
        goal: "Enable line numbers",
        exact: { identifier: "line-numbers", value: "1" },
        evaluate: recoverByReobserving,
        recovery: { mode: "bounded" },
    });
    expect(fixture.calls()).toBe(1);
    expect(result.status).toBe("unknown");
    expect(result.recoveries[0]).toMatchObject({ category: "transport_uncertainty", selected: null });
    expect(actionRefusal({ ok: false, error: "stale observation" })).toBe("transport_uncertainty");
});
test("recovery caps, permission, authentication and changed scope cannot expand execution", async () => {
    const fixture = taskDriver();
    let attempts = 0;
    fixture.driver.act = async () => {
        attempts++;
        return { ok: false, dispatchState: "not_started", refusal: "stale_observation" };
    };
    const result = await assistTask({
        driver: fixture.driver,
        goal: "Enable line numbers",
        exact: { identifier: "line-numbers", value: "1" },
        evaluate: recoverByReobserving,
        recovery: { mode: "bounded", maxRecoveries: 1 },
    });
    expect(attempts).toBe(2);
    expect(result.recoveries).toHaveLength(1);
    for (const category of ["permission", "authentication", "scope_changed", "transport_uncertainty"] as const) {
        const session = new ControlSession({
            driver: fixture.driver,
            evaluate: async () => {
                throw new Error("Must not call model");
            },
        });
        const recovery = new RecoveryController({ mode: "bounded" });
        expect(await recovery.recover({ session, category, goal: "Continue" })).toBeNull();
        expect(session.report().requests).toBe(0);
    }
    expect(
        authenticationBarrier({
            ...semanticFixture,
            elements: [{ index: 0, depth: 0, role: "AXTextField", AXSubrole: "AXSecureTextField" }],
        })
    ).toBe(true);
});
test("only uniquely observed explicitly authorized recovery buttons can be dispatched", async () => {
    const fixture = taskDriver({ noChange: true });
    const session = new ControlSession({
        driver: fixture.driver,
        evaluate: async (call) => {
            const input = evaluationSchema.parse(call.input);
            const q = input.questions.remedy;
            if (q.type !== "choice") {
                throw new Error("Expected remedy");
            }
            expect(q.criteria).not.toHaveProperty("close-help");
            return evaluation({ remedy: { type: "choice", choice: "close-help", probabilities: { "close-help": 1 } } });
        },
    });
    const recovery = new RecoveryController({
        mode: "bounded",
        remedies: [
            {
                id: "close-help",
                kind: "dismiss",
                identifier: "help-close",
                role: "AXButton",
                label: "Close help",
                description: "Dismiss help only",
            },
        ],
    });
    expect(
        await recovery.recover({
            session,
            observation: await session.observe(),
            category: "semantic_interruption",
            goal: "Continue",
        })
    ).toBeNull();
    expect(fixture.calls()).toBe(0);
});

function formPlan(): WorkflowPlan {
    return {
        version: 1,
        app: "FormFixture",
        scope: "window",
        windowTitle: "Profile",
        steps: [
            {
                id: "name",
                action: "set",
                selector: { identifier: "name" },
                intent: "Enter the supplied name",
                valueRef: "nameValue",
                postcondition: { expect: "Name entered", exact: { identifier: "name", valueRef: "nameValue" } },
                noRetry: true,
            },
            {
                id: "city",
                action: "set",
                selector: { identifier: "city" },
                intent: "Enter the supplied city",
                valueRef: "cityValue",
                postcondition: { expect: "City entered", exact: { identifier: "city", valueRef: "cityValue" } },
                noRetry: true,
            },
        ],
    };
}
test("resilient workflows bind reordered fields without model calls and keep values out of traces", async () => {
    const fixture = formDriver();
    const result = await replayWorkflow({
        plan: formPlan(),
        driver: fixture.driver,
        values: { nameValue: "Private Name", cityValue: "Private Town" },
        evaluate: async () => {
            throw new Error("Exact plan must not call model");
        },
    });
    expect(result.status).toBe("verified");
    expect(fixture.calls.map((call) => call.candidate.element)).toEqual([0, 0]);
    expect(result.steps.every((step) => step.suppliedValueVerified)).toBe(true);
    expect(result.metrics.requests).toBe(0);
    expect(SafeJSON.stringify(result)).not.toContain("Private Name");
    expect(SafeJSON.stringify(result)).not.toContain("Private Town");
});
test("workflow rebind is opt-in, constrained to the same action, and never silently persists", async () => {
    const plan = formPlan();
    plan.steps = [plan.steps[0]];
    plan.steps[0].selector = { label: "Former full-name label" };
    const fixture = formDriver();
    const captured: string[] = [];
    const result = await replayWorkflow({
        plan,
        driver: fixture.driver,
        values: { nameValue: "Private Name" },
        rebind: true,
        evaluate: chooseField(captured),
    });
    expect(result.status).toBe("verified");
    expect(result.steps[0].binding).toBe("jev");
    expect(result.repairs).toHaveLength(1);
    expect(fixture.calls[0].candidate.action).toBe("set");
    expect(plan.steps[0].selector.label).toBe("Former full-name label");
    const repaired = applyWorkflowRepairs({ plan, repairs: result.repairs });
    expect(repaired.steps[0].selector.identifier).toBe("name");
    expect(captured.join("")).not.toContain("Private Name");
    const disabled = formDriver();
    const stopped = await replayWorkflow({
        plan,
        driver: disabled.driver,
        values: { nameValue: "Name" },
        evaluate: chooseField([]),
    });
    expect(stopped.status).toBe("stopped");
    expect(disabled.calls).toHaveLength(0);
});
test("workflow preflight refuses missing values before reading or mutating", async () => {
    const fixture = formDriver();
    await expect(
        replayWorkflow({ plan: formPlan(), driver: fixture.driver, evaluate: chooseField([]) })
    ).rejects.toThrow("Missing supplied value");
    expect(fixture.observations()).toBe(0);
    expect(fixture.calls).toHaveLength(0);
});
test("workflow ambiguity, scope change, wrong readback and unknown mutation stop subsequent steps", async () => {
    for (const config of [{ failWrite: true }, { wrongWindow: true }, { corruptReadback: true }]) {
        const fixture = formDriver(config);
        const result = await replayWorkflow({
            plan: formPlan(),
            driver: fixture.driver,
            values: { nameValue: "Name", cityValue: "Town" },
            evaluate: chooseField([]),
        });
        expect(result.status).not.toBe("verified");
        expect(fixture.calls).toHaveLength(1);
    }
    const fixture = formDriver();
    const originalObserve = fixture.driver.observe;
    fixture.driver.observe = async (call) => {
        const observation = await originalObserve(call);
        observation.elements[1].AXIdentifier = "name";
        return observation;
    };
    const result = await replayWorkflow({
        plan: formPlan(),
        driver: fixture.driver,
        values: { nameValue: "Name", cityValue: "Town" },
        rebind: true,
        evaluate: async () => {
            throw new Error("Ambiguous original selector must stop before chooser");
        },
    });
    expect(result.steps[0].reason).toContain("ambiguous");
    expect(fixture.calls).toHaveLength(0);
});
test("semantic recording replaces inline values and refuses action/selector changes", () => {
    const plan = formPlan();
    const legacy = {
        app: "FormFixture",
        steps: [
            { do: "set", id: "name", value: "Secret A" },
            { do: "set", id: "city", value: "Secret B" },
        ],
    };
    const envelope = attachSemanticPlan({ legacy, semantic: plan });
    expect(SafeJSON.stringify(envelope)).not.toContain("Secret");
    expect(envelope.semantic).toEqual(plan);
    expect(legacy.steps[0].value).toBe("Secret A");
    expect(() =>
        attachSemanticPlan({
            legacy: { ...legacy, steps: [{ do: "press", id: "name" }, legacy.steps[1]] },
            semantic: plan,
        })
    ).toThrow("app/action");
    const changed = structuredClone(plan);
    changed.steps[0].selector = { identifier: "city" };
    expect(() => attachSemanticPlan({ legacy, semantic: changed })).toThrow("differs");
});

test("semantic recording preserves fixed action parameters and rejects dropped effects", () => {
    const plan = formPlan();
    plan.steps = [{ ...plan.steps[0], action: "key", valueRef: undefined, parameters: { keys: "cmd,a" } }];
    const legacy = { app: plan.app, steps: [{ do: "key", id: "name", keys: "cmd,a" }] };
    expect(attachSemanticPlan({ legacy, semantic: plan }).semantic.steps[0].parameters).toEqual({ keys: "cmd,a" });
    const changed = structuredClone(plan);
    changed.steps[0].parameters = { keys: "cmd,q" };
    expect(() => attachSemanticPlan({ legacy, semantic: changed })).toThrow("parameters");
    expect(() =>
        attachSemanticPlan({
            legacy: { ...legacy, steps: [{ ...legacy.steps[0], hold: 500 }] },
            semantic: plan,
        })
    ).toThrow("unsupported option hold");

    const typing = formPlan();
    typing.steps = [{ ...typing.steps[0], action: "type" }];
    expect(() =>
        attachSemanticPlan({
            legacy: { app: typing.app, steps: [{ do: "type", id: "name", text: "private", return: true }] },
            semantic: typing,
        })
    ).toThrow("unsupported option return");
});

test("native observation waits propagate cancellation before another observation", async () => {
    const controller = new AbortController();
    let started = false;
    let observations = 0;
    const source = new NativeObservationSource({
        driver: {
            observe: async () => {
                observations++;
                return semanticFixture;
            },
            act: async () => {
                throw new Error("Wait cannot act");
            },
        },
        run: async ({ signal, args, timeoutMs }) => {
            expect(args[0]).toBe("wait-change");
            expect(timeoutMs).toBe(1000);
            expect(signal).toBe(controller.signal);
            started = true;
            return new Promise((resolve) =>
                signal!.addEventListener("abort", () => resolve({ ok: false, error: "cancelled" }), { once: true })
            );
        },
    });
    const pending = source.next({ previous: semanticFixture, signal: controller.signal, timeoutMs: 1000 });
    expect(started).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(observations).toBe(0);
});

function chooserSession(evaluate: Evaluator) {
    return new ControlSession({
        evaluate,
        driver: {
            observe: async () => semanticFixture,
            act: async () => {
                throw new Error("Read-only chooser");
            },
        },
    });
}
function uncertainChooser(config: { coverage?: number; conflict?: number; strong?: boolean } = {}): Evaluator {
    return async (call) => {
        const input = evaluationSchema.parse(call.input);
        const target = input.questions.target;
        if (target.type !== "choice") {
            throw new Error("Expected target choice");
        }
        const ids = Object.keys(target.criteria);
        const choice = config.strong ? "c0" : "abstain";
        return evaluation({
            target: {
                type: "choice",
                choice,
                probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
            },
            coverage: { type: "boolean", probability: config.coverage ?? 0.5 },
            conflict: { type: "boolean", probability: config.conflict ?? 0 },
        });
    };
}
test("auto chooser spends zero requests for a unique exact supplied binding", async () => {
    const session = chooserSession(async () => {
        throw new Error("Exact binding must not call AI");
    });
    const result = await chooseCandidate({
        observation: semanticFixture,
        intent: "Account settings",
        mode: "auto",
        binding: { identifier: "account-settings" },
        session,
    });
    expect(result.selected?.element).toBe(1);
    expect(result.source).toBe("exact");
    expect(session.report().requests).toBe(0);
});
test("auto chooser keeps coverage, conflict, probability and confidence separate", async () => {
    for (const config of [
        { coverage: 0.4, strong: true },
        { coverage: 1, conflict: 1, strong: true },
        { coverage: 1 },
    ]) {
        const session = chooserSession(uncertainChooser(config));
        const result = await chooseCandidate({
            observation: semanticFixture,
            intent: "Open account preferences",
            mode: "auto",
            session,
        });
        expect(result.status).toBe("escalated");
        expect(result.selected).toBeNull();
        expect(result.packet?.candidates).toHaveLength(2);
        expect(session.report().requests).toBe(1);
    }
    const admitted = await chooseCandidate({
        observation: semanticFixture,
        intent: "Open account preferences",
        mode: "auto",
        session: chooserSession(uncertainChooser({ coverage: 1, strong: true })),
    });
    expect(admitted.status).toBe("resolved");
});
test("host handoff accepts only current candidate and evidence IDs, without calling another model", async () => {
    const observation = {
        ...semanticFixture,
        elements: [...semanticFixture.elements, { index: 6, depth: 0, role: "AXTextField", AXValue: "PRIVATE SECRET" }],
    };
    const session = chooserSession(uncertainChooser());
    const first = await chooseCandidate({ observation, intent: "Open account preferences", mode: "auto", session });
    const packet = first.packet;
    if (!packet) {
        throw new Error("Expected packet");
    }
    expect(SafeJSON.stringify(packet)).not.toContain("PRIVATE SECRET");
    const answer = { packetId: packet.packetId, choice: "c0", evidence: ["e1"] };
    const hostDecision = readHostDecision({ packet, answer });
    const second = await chooseCandidate({
        observation,
        intent: "Open account preferences",
        mode: "auto",
        session,
        hostDecision,
    });
    expect(second.source).toBe("host");
    expect(second.selected?.element).toBe(1);
    expect(session.report().requests).toBe(1);
    const zeroRequestSession = chooserSession(async () => {
        throw new Error("Host answer must not call Jev");
    });
    const declined = await chooseCandidate({
        observation,
        intent: "Open account preferences",
        mode: "auto",
        session: zeroRequestSession,
        hostDecision: { packet, answer: { ...answer, choice: null } },
    });
    expect(declined.status).toBe("abstained");
    expect(zeroRequestSession.report().requests).toBe(0);
    const conflict = await chooseCandidate({
        observation,
        intent: "Open account preferences",
        mode: "auto",
        session: zeroRequestSession,
        hostDecision: { packet: { ...packet, signals: { ...packet.signals, conflict: 1 } }, answer },
    });
    expect(conflict.status).toBe("escalated");
    expect(conflict.selected).toBeNull();
    expect(zeroRequestSession.report().requests).toBe(0);
    expect(() =>
        acceptHostChoice({ packet, currentPacket: packet, response: { ...answer, choice: "invented" } })
    ).toThrow("unknown candidate");
    expect(() =>
        acceptHostChoice({ packet, currentPacket: packet, response: { ...answer, evidence: ["e999"] } })
    ).toThrow("evidence");
    expect(() =>
        acceptHostChoice({ packet, currentPacket: packet, response: answer, now: packet.expiresAt + 1 })
    ).toThrow("expired");
    expect(() => readHostDecision({ packet, answer: { ...answer, command: "shell" } })).toThrow();
    const changed = structuredClone(observation);
    changed.elements[1].AXTitle = "Different operation";
    await expect(
        chooseCandidate({
            observation: changed,
            intent: "Open account preferences",
            mode: "auto",
            session,
            hostDecision,
        })
    ).rejects.toThrow("changed");
});
test("chooser comparison is exact-only until Jev is explicitly enabled", async () => {
    const result = await compareChoosers({
        input: {},
        evaluate: async () => {
            throw new Error("No Jev permission");
        },
    });
    expect(result.metrics.requests).toBe(0);
    expect(result.summary).toHaveLength(1);
    expect(result.summary[0].mode).toBe("exact");
    expect(result.rows.every((row) => row.split === "held-out")).toBe(true);
});

test("calibration reuses one response per case and mode without additional paid calls", async () => {
    let calls = 0;
    const result = await compareChoosers({
        input: { jev: true, split: "all", calibrate: true },
        evaluate: async (call) => {
            calls++;
            const input = evaluationSchema.parse(call.input);
            const answers: EvaluationResponse["answers"] = {};
            for (const [id, question] of Object.entries(input.questions)) {
                if (question.type === "boolean") {
                    answers[id] = { type: "boolean", probability: id === "coverage" ? 1 : 0 };
                } else if (question.type === "choice") {
                    const keys = Object.keys(question.criteria);
                    const choice = keys[0];
                    answers[id] = {
                        type: "choice",
                        choice,
                        probabilities: Object.fromEntries(
                            keys.map((key) => [key, key === choice ? 0.82 : 0.18 / (keys.length - 1)])
                        ),
                    };
                }
            }
            return {
                model: "fixture",
                answers,
                usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
                warnings: [],
                rounding: undefined,
                providerMetadata: undefined,
            };
        },
    });
    expect(calls).toBe(19);
    expect(result.metrics.requests).toBe(calls);
    expect(result.metrics.actions).toBe(0);
    expect(result.calibration?.rows).toHaveLength(80);
    expect(result.calibration?.runtimePolicyChanged).toBe(false);
    const curves = result.calibration!.curves.filter((row) => row.mode === "jev");
    expect(curves[0].development.abstentions).toBe(0);
    expect(curves[1].development.abstentions).toBe(5);
    expect(result.summary.find((row) => row.mode === "jev")?.inputTokens).toBeNull();
    expect(result.summary.find((row) => row.mode === "jev")?.costUsd).toBeNull();
    await expect(compareChoosers({ input: { calibrate: true } })).rejects.toThrow("opt-in");
    await expect(compareChoosers({ input: { jev: true, calibrate: true } })).rejects.toThrow("split all");
});

test("calibration selects only from development labels and keeps default on ties", () => {
    const rows: CalibrationRow[] = [0, 1].flatMap((policy) => [
        {
            fixture: "train",
            split: "development",
            mode: "jev",
            policy,
            expected: 1,
            selected: policy ? null : 2,
            status: "resolved",
        },
        { fixture: "test", split: "held-out", mode: "jev", policy, expected: 2, selected: 2, status: "resolved" },
    ]);
    expect(calibrationReport(rows).selected[0]?.policyIndex).toBe(1);
    const changedLabels = rows.map((row) => (row.split === "held-out" ? { ...row, expected: null } : row));
    expect(calibrationReport(changedLabels).selected[0]?.policyIndex).toBe(1);
    const tied = rows.map((row) => ({ ...row, selected: null }));
    expect(calibrationReport(tied).selected[0]?.policyIndex).toBe(0);
});

test("exact-only assist cannot silently make semantic judgment or recovery calls", async () => {
    const fixture = taskDriver();
    const evaluate: Evaluator = async () => {
        throw new Error("Jev was not enabled");
    };
    await expect(
        assistTask({ driver: fixture.driver, evaluate, goal: "Show line numbers", chooser: "exact" })
    ).rejects.toThrow("Exact-only assist");
    await expect(
        assistTask({
            driver: fixture.driver,
            evaluate,
            goal: "Show line numbers",
            chooser: "exact",
            exact: { identifier: "line-numbers", value: "1" },
            recovery: { mode: "bounded" },
        })
    ).rejects.toThrow("Exact-only assist");
    const result = await assistTask({
        driver: fixture.driver,
        evaluate,
        goal: "Show line numbers",
        chooser: "exact",
        exact: { identifier: "line-numbers", value: "1" },
    });
    expect(result.status).toBe("verified");
    expect(result.metrics.requests).toBe(0);
});

function visualFixture() {
    return visualObservationSchema.parse({
        ok: true,
        app: "Visual fixture",
        pid: 1,
        processLaunch: 100,
        snapshot: "fixture",
        window: { id: 7, title: "Visual fixture", x: -400, y: 0, width: 400, height: 300 },
        screenshot: { path: "/fixture.png", width: 800, height: 600 },
        perception: {
            method: "vision-ocr",
            expiresInSeconds: 30,
            capture: {
                id: "11111111-1111-4111-8111-111111111111",
                pid: 1,
                launch: 100,
                windowID: 7,
                created: 1000,
                bounds: { x: -400, y: 0, width: 400, height: 300 },
                pngHash: "a".repeat(64),
                pixelHash: "b".repeat(64),
                transform: {
                    sourceWidth: 800,
                    sourceHeight: 600,
                    crop: { x: 0, y: 0, width: 800, height: 600 },
                    processedWidth: 800,
                    processedHeight: 600,
                },
                regions: [{ id: "v0", source: { x: 100, y: 100, width: 80, height: 40 } }],
            },
            regions: [
                {
                    id: "v0",
                    text: "Paint",
                    confidence: 1,
                    source: { x: 100, y: 100, width: 80, height: 40 },
                    screen: { x: -350, y: 50, width: 40, height: 20 },
                },
            ],
        },
    });
}
test("visual selection defaults to local exact matching and dispatch requires explicit execute", async () => {
    let actions = 0;
    const observation = visualFixture();
    const driver: VisualDriver = {
        observe: async () => observation,
        click: async (call) => {
            actions++;
            expect(call.regionId).toBe("v0");
            return { ok: true };
        },
    };
    const inspected = await visualTask({
        driver,
        intent: "Paint",
        evaluate: async () => {
            throw new Error("No AI allowed");
        },
    });
    expect(inspected.choice.source).toBe("exact");
    expect(actions).toBe(0);
    const dispatched = await visualTask({ driver, intent: "Paint", execute: true });
    expect(actions).toBe(1);
    expect(dispatched.verification).toBe("unverified");
    expect(dispatched.metrics.requests).toBe(0);
});
test("visual Jev cannot supply a made-up region or action arguments", async () => {
    let actions = 0;
    const driver: VisualDriver = {
        observe: async () => visualFixture(),
        click: async () => {
            actions++;
            throw new Error("Must not dispatch");
        },
    };
    const result = await visualTask({
        driver,
        intent: "Paint",
        chooser: "jev",
        execute: true,
        evaluate: async () => evaluation({ target: { type: "choice", choice: "v999", probabilities: { v999: 1 } } }),
    });
    expect(result.choice.status).toBe("abstained");
    expect(actions).toBe(0);
    expect(result.metrics.requests).toBe(1);
});
test("empty OCR detections abstain without spending a Jev request or attempting input", async () => {
    const observation = visualFixture();
    observation.perception.regions = [];
    observation.perception.capture.regions = [];
    for (const chooser of ["exact", "jev"] as const) {
        const result = await visualTask({
            driver: {
                observe: async () => observation,
                click: async () => {
                    throw new Error("An empty detection cannot be clicked");
                },
            },
            intent: "Paint",
            chooser,
            execute: true,
            evaluate: async () => {
                throw new Error("An empty detection must not reach Jev");
            },
        });
        expect(result.choice.status).toBe("abstained");
        expect(result.metrics.requests).toBe(0);
        expect(result.metrics.actions).toBe(0);
        expect(result.action).toBeUndefined();
    }
});
test("visual transport uncertainty never retries the chosen region", async () => {
    let actions = 0;
    const result = await visualTask({
        intent: "Paint",
        execute: true,
        driver: {
            observe: async () => visualFixture(),
            click: async () => {
                actions++;
                return { ok: false, dispatchState: "uncertain", error: "Lost reply" };
            },
        },
    });
    expect(actions).toBe(1);
    expect(result.action?.ok).toBe(false);
    expect(result.verification).toBe("unverified");
});
test("visual observations reject mismatched capture identity and duplicate regions", () => {
    const capture = visualFixture();
    expect(visualObservationSchema.safeParse({ ...capture, pid: 2 }).success).toBe(false);
    expect(
        visualObservationSchema.safeParse({
            ...capture,
            perception: {
                ...capture.perception,
                regions: [...capture.perception.regions, ...capture.perception.regions],
            },
        }).success
    ).toBe(false);
});

test("visual geometry is tied to the capture and oversized semantic candidate sets make no AI call", async () => {
    const source = visualFixture();
    const tampered = structuredClone(source);
    tampered.perception.regions[0].screen.x += 1;
    expect(visualObservationSchema.safeParse(tampered).success).toBe(false);
    source.perception.regions = Array.from({ length: 81 }, (_, index) => ({
        ...source.perception.regions[0],
        id: `v${index}`,
        text: `Button ${index}`,
    }));
    source.perception.capture.regions = source.perception.regions.map(({ id, source }) => ({ id, source }));
    let requests = 0;
    await expect(
        visualTask({
            intent: "Choose a button",
            chooser: "jev",
            driver: {
                observe: async () => source,
                click: async () => {
                    throw new Error("Must not act");
                },
            },
            evaluate: async () => {
                requests++;
                throw new Error("Must not call model");
            },
        })
    ).rejects.toThrow("80 OCR");
    expect(requests).toBe(0);
});

test("large observations keep exact readback and exact target binding local while semantic choices stay bounded", async () => {
    const observation: Observation = {
        ...semanticFixture,
        elements: Array.from({ length: 500 }, (_, index) => ({
            index,
            depth: 0,
            role: "AXButton",
            AXIdentifier: `button-${index}`,
            AXTitle: `Button ${index}`,
            AXValue: "ready",
            actions: ["AXPress"],
        })),
    };
    let calls = 0;
    const evaluate: Evaluator = async () => {
        calls++;
        throw new Error("Must not call AI");
    };
    const exact = await judgeOutcome({
        observation,
        expect: "Ready",
        exact: { identifier: "button-499", value: "ready" },
        evaluate,
    });
    expect(exact.status).toBe("verified");
    expect(exact.observations).toHaveLength(1);
    const choice = await chooseCandidate({
        observation,
        intent: "Button 499",
        mode: "auto",
        session: chooserSession(evaluate),
    });
    expect(choice.selected?.element).toBe(499);
    expect(choice.candidates).toHaveLength(1);
    expect(choice.candidateCount).toBe(500);
    await expect(resolveIntent({ observation, intent: "Find the right button", evaluate })).rejects.toThrow(
        "80 actionable"
    );
    expect(calls).toBe(0);
});
test("monotonic remaining budgets are integers accepted by strict timeout APIs", () => {
    let now = 0;
    const budget = new OperationBudget({ timeoutMs: 2, clock: { now: () => now } });
    now = 0.25;
    expect(budget.remaining()).toBe(1);
    now = 1.25;
    expect(() => budget.remaining()).toThrow("deadline");
});

test("resilient workflows keep broad native actions fixed and values local", async () => {
    let state: Observation = {
        ...semanticFixture,
        app: "BroadFixture",
        elements: [
            { index: 0, depth: 0, role: "AXWindow", AXIdentifier: "window", x: 0, y: 0, width: 400, height: 300 },
            {
                index: 1,
                depth: 1,
                role: "AXTextField",
                AXIdentifier: "field",
                valueSettable: true,
                AXValue: "",
                AXFocused: true,
                x: 20,
                y: 30,
                width: 100,
                height: 25,
            },
            {
                index: 2,
                depth: 1,
                role: "AXButton",
                AXIdentifier: "button",
                AXTitle: "More",
                actions: ["AXPress", "AXShowMenu"],
                x: 30,
                y: 70,
                width: 50,
                height: 20,
            },
            { index: 3, depth: 1, role: "AXScrollArea", AXIdentifier: "scroll", x: 0, y: 100, width: 300, height: 100 },
            { index: 4, depth: 1, role: "AXStaticText", AXIdentifier: "status", AXValue: "" },
        ],
    };
    const actions: WorkflowPlan["steps"] = [
        {
            id: "focus",
            action: "focus",
            selector: { identifier: "field" },
            intent: "Focus the field",
            postcondition: { expect: "Focused", exact: { identifier: "field", attribute: "AXFocused", value: "true" } },
            noRetry: true,
        },
        ...(["key", "type", "paste", "select", "perform", "scroll", "click"] as const).map((action) => ({
            id: action,
            action,
            intent: action,
            selector: {
                identifier:
                    action === "perform" || action === "click" ? "button" : action === "scroll" ? "scroll" : "field",
            },
            parameters:
                action === "key"
                    ? { keys: "super+a" }
                    : action === "perform"
                      ? { axAction: "AXShowMenu" }
                      : action === "scroll"
                        ? { direction: "down" as const, pixels: 40 }
                        : undefined,
            valueRef: ["type", "paste", "select"].includes(action) ? "private" : undefined,
            postcondition: { expect: action, exact: { identifier: "status", value: action } },
            noRetry: true as const,
        })),
    ];
    const calls: Array<Parameters<ControlDriver["act"]>[0]> = [];
    const driver: ControlDriver = {
        observe: async () => structuredClone(state),
        act: async (call) => {
            calls.push(call);
            state = {
                ...state,
                snapshot: `next-${calls.length}`,
                elements: state.elements.map((row) =>
                    row.AXIdentifier === "status" ? { ...row, AXValue: call.candidate.action } : row
                ),
            };
            return { ok: true };
        },
    };
    const result = await replayWorkflow({
        plan: { version: 1, app: "BroadFixture", scope: "window", steps: actions },
        values: { private: "Supplied only" },
        driver,
        evaluate: async () => {
            throw new Error("No AI enabled");
        },
    });
    expect(result.status).toBe("verified");
    expect(calls.map((call) => call.candidate.action)).toEqual(actions.map((step) => step.action));
    expect(calls.find((call) => call.candidate.action === "perform")?.parameters).toEqual({ axAction: "AXShowMenu" });
    expect(calls.find((call) => call.candidate.action === "paste")?.value).toBe("Supplied only");
    expect(SafeJSON.stringify(result)).not.toContain("Supplied only");
    expect(result.metrics.requests).toBe(0);
    const invalid = structuredClone(actions);
    invalid[0].parameters = { keys: "cmd+q" };
    await expect(
        replayWorkflow({
            plan: { version: 1, app: "BroadFixture", steps: invalid },
            values: { private: "X" },
            driver,
            evaluate: chooseFirst,
        })
    ).rejects.toThrow("not valid for focus");
    expect(calls).toHaveLength(8);
});
test("semantic workflow verification needs opt-in before any observation", async () => {
    const fixture = formDriver();
    const plan = formPlan();
    plan.steps[0].postcondition = { expect: "Profile saved" };
    await expect(
        replayWorkflow({
            plan,
            values: { nameValue: "Name", cityValue: "City" },
            driver: fixture.driver,
            evaluate: chooseFirst,
        })
    ).rejects.toThrow("explicit Jev approval");
    expect(fixture.observations()).toBe(0);
});

test("action refresh is reused once and changed scope cannot become a new action target", async () => {
    for (const wrongScope of [false, true]) {
        let reads = 0;
        const session = new ControlSession({
            driver: {
                observe: async () => {
                    reads++;
                    return semanticFixture;
                },
                act: async () => ({
                    ok: true,
                    after: {
                        ...semanticFixture,
                        snapshot: "fresh-after",
                        window: { ...semanticFixture.window, id: wrongScope ? 99 : semanticFixture.window.id },
                    },
                }),
            },
            evaluate: chooseFirst,
        });
        const observed = await session.observe();
        const result = await session.dispatch({
            observation: observed,
            candidate: candidatesFor({ observation: observed })[0],
        });
        expect(reads).toBe(1);
        if (wrongScope) {
            expect(result.after).toBeUndefined();
            expect(result.observationError).toContain("window changed");
        } else {
            expect(result.after?.snapshot).toBe("fresh-after");
        }
    }
});

test("visual capture store binds bytes to IDs, consumes clicks once and deletes only owned files", async () => {
    let calls = 0;
    const files: string[] = [];
    const payload = Buffer.from("fixture image bytes");
    const store = new VisualCaptureStore((options) => ({
        observe: async () => {
            files.push(options.path);
            await Bun.write(options.path, payload);
            const observation = visualFixture();
            observation.screenshot.path = options.path;
            observation.perception.capture.created = Date.now() / 1000;
            observation.perception.capture.pngHash = createHash("sha256").update(payload).digest("hex");
            return observation;
        },
        click: async () => {
            calls++;
            return { ok: true };
        },
    }));
    try {
        const signal = new AbortController().signal;
        const capture = await store.capture({ app: "Fixture" }, signal);
        expect(Buffer.from(await store.image(capture.id)).equals(payload)).toBe(true);
        const choice = await store.choose({ id: capture.id, intent: "Paint" }, { provider: "typesafe", signal });
        expect(choice.source).toBe("exact");
        expect(choice.metrics.requests).toBe(0);
        await expect(store.click({ id: capture.id, regionId: "invented" }, signal)).rejects.toThrow("observed region");
        expect(calls).toBe(0);
        expect((await store.click({ id: capture.id, regionId: "v0" }, signal)).consumed).toBe(true);
        await expect(store.click({ id: capture.id, regionId: "v0" }, signal)).rejects.toThrow("consumed");
        expect(calls).toBe(1);
        for (let index = 0; index < 4; index++) {
            await store.capture({ app: "Fixture" }, signal);
        }
        await expect(store.image(capture.id)).rejects.toThrow("expired or was replaced");
        expect(await Bun.file(files[0]).exists()).toBe(false);
        await Bun.write(files.at(-1)!, "changed");
        const last = await store.capture({ app: "Fixture" }, signal);
        await Bun.write(files.at(-1)!, "changed");
        await expect(store.image(last.id)).rejects.toThrow("changed");
    } finally {
        store.dispose();
    }
    for (const file of files) {
        expect(await Bun.file(file).exists()).toBe(false);
    }
});
test("resilience fixtures exercise unknown delivery and ambiguous selectors without AI", async () => {
    for (const id of ["stale", "unknown", "permission", "cap", "reordered", "renamed", "ambiguous"]) {
        const replay = await replayResilience({
            input: { id },
            evaluate: async () => {
                throw new Error("AI disabled");
            },
        });
        expect(replay.paidRequests).toBe(0);
        if (id === "unknown" || id === "permission") {
            expect(replay.dispatchAttempts).toBe(1);
            expect(replay.result.status).toBe("unknown");
        }
        if (id === "ambiguous") {
            expect(replay.dispatchAttempts).toBe(0);
        }
        if (id === "cap") {
            expect(replay.dispatchAttempts).toBe(3);
        }
        if (["stale", "reordered", "renamed"].includes(id)) {
            expect(replay.result.status).toBe("verified");
        }
    }
});

test("generic sequence facade requires Jev opt-in and keeps one native session across windows", async () => {
    let created = 0;
    const input = {
        app: "Fixture",
        intent: "Visit every tab",
        role: "AXRadioButton",
        rootRole: "AXTabGroup",
        windowIds: [1, 2],
        restoreSelected: true,
        verifyAttribute: "AXSelected",
    };
    const fixture = sessionFixture();
    const createSession = () => {
        created++;
        return fixture.session;
    };
    await expect(runNativeSequence({ input, createSession })).rejects.toThrow();
    expect(created).toBe(0);
    const result = await runNativeSequence({ input: { ...input, jev: true }, createSession });
    expect(result.ok).toBe(true);
    expect(result.windows).toHaveLength(2);
    expect(created).toBe(1);
    expect(fixture.requests.map((request) => request.op)).toEqual([
        "observe",
        "batch",
        "act",
        "observe",
        "batch",
        "act",
    ]);
    expect(fixture.closed()).toBe(true);
});
test("generic sequence refuses low confidence and never restores after uncertain delivery", async () => {
    const input = {
        app: "Fixture",
        intent: "Visit every tab",
        role: "AXRadioButton",
        rootRole: "AXTabGroup",
        restoreSelected: true,
        jev: true,
    };
    const low = sessionFixture({
        evaluate: async () => ({
            ...evaluation({ matches: { type: "boolean", probability: 0.99 } }),
            providerMetadata: { typesafe: { confidence: { matches: 0.4 } } },
        }),
    });
    const stopped = await runNativeSequence({ input, createSession: () => low.session });
    expect(stopped.ok).toBe(false);
    expect(low.requests).toHaveLength(1);
    const lost = sessionFixture({ reply: { ok: false, dispatchState: "uncertain" } });
    const uncertain = await runNativeSequence({ input, createSession: () => lost.session });
    expect(uncertain.ok).toBe(false);
    expect(lost.requests.map((request) => request.op)).toEqual(["observe", "batch"]);
});
test("standalone OCR choices return current region refs and reject invented or stale refs", async () => {
    const observed = { ...visualFixture(), elements: [] };
    observed.perception.capture.created = Date.now() / 1000;
    const calls: string[][] = [];
    const computer = new ComputerUse({
        native: {
            run: async ({ args }) => {
                calls.push(args);
                return args[0] === "see" ? structuredClone(observed) : { ok: true };
            },
        },
    });
    try {
        const state = await computer.get_app_state({ app: "Visual fixture", perception: "ocr" });
        expect(state.visual?.regions[0].ref).toContain(":visual:v0");
        const chosen = await computer.resolve_visual_target({ app: "Visual fixture", intent: "Paint" });
        expect(chosen.source).toBe("exact");
        expect(chosen.metrics.requests).toBe(0);
        await expect(computer.click({ app: "Visual fixture", region_ref: "invented" })).rejects.toThrow(
            "current observed"
        );
        await computer.get_app_state({ app: "Visual fixture", perception: "ocr" });
        await expect(computer.click({ app: "Visual fixture", region_ref: chosen.region_ref! })).rejects.toThrow(
            "current observed"
        );
        const fresh = await computer.resolve_visual_target({ app: "Visual fixture", intent: "Paint" });
        const clicked = await computer.click({ app: "Visual fixture", region_ref: fresh.region_ref! });
        expect(clicked.ok).toBe(true);
        expect(calls.at(-1)).toContain("--region");
        expect(calls.at(-1)).not.toContain("--coords");
        expect(calls.filter((args) => args[0] === "act")).toHaveLength(1);
    } finally {
        computer.close_session();
    }
});
