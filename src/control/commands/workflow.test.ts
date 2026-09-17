import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { assistTask } from "../lib/decision/assist";
import { admittedChoice, judgeOutcome, resolveIntent } from "../lib/decision/decisions";
import { fillForm } from "../lib/decision/fill";
import { replayCases } from "../lib/decision/fixtures";
import { type FolderDriver, navigateFolders } from "../lib/decision/folders";
import type { ControlDriver } from "../lib/decision/native";
import { candidatesFor, type Observation } from "../lib/decision/observation";
import { replayControl } from "../lib/decision/replay";

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
test("see and act help name the diff and refresh options", () => {
    const see = spawnSync("bun", [entry, "see", "--help"], { env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(see.status).toBe(0);
    expect(see.stdout).toContain("--since <json>");

    const act = spawnSync("bun", [entry, "act", "--help"], { env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(act.status).toBe(0);
    expect(act.stdout).toContain("--refresh");
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

function folderFixture() {
    let time = 0;
    const calls: Array<{ id: string; at: number; expanded: boolean }> = [];
    const folders = ["agents", "docs", "src"].map((label, index) => ({
        id: `f${index}`,
        label,
        expanded: false,
        reference: `reference-${index}`,
    }));
    const driver: FolderDriver = {
        inspect: async () => ({ ok: true, scope: "unique-outline", pid: 1, windowId: 2, folders }),
        set: async (call) => {
            calls.push({ id: call.target.id, at: time, expanded: call.expanded });
            return { ok: true, verified: true, expanded: call.expanded, changed: true };
        },
    };
    return {
        driver,
        calls,
        clock: {
            now: () => time,
            sleep: async (ms: number) => {
                time += ms;
            },
        },
    };
}
test("folder sequence resolves explicit names without a model and schedules in one process", async () => {
    const fixture = folderFixture();
    const result = await navigateFolders({
        ...fixture,
        names: ["agents", "docs", "src"],
        mode: "open",
        evaluate: async () => {
            throw new Error("Exact names must not call Jev");
        },
    });
    expect(result.status).toBe("verified");
    expect(result.metrics.requests).toBe(0);
    expect(fixture.calls.map((call) => call.at)).toEqual([0, 1000, 2000]);
    expect(result.bindings.every((binding) => binding.source === "exact")).toBe(true);
});
test("semantic folder intents share one evaluation and uncertain batches never begin dispatch", async () => {
    const fixture = folderFixture();
    let requests = 0;
    const evaluate: Evaluator = async (call) => {
        requests++;
        const request = evaluationSchema.parse(call.input);
        expect(Object.keys(request.questions)).toEqual(["q0", "q1"]);
        return evaluation(
            Object.fromEntries(
                ["q0", "q1"].map((id, index) => [
                    id,
                    {
                        type: "choice" as const,
                        choice: `f${index}`,
                        probabilities: { f0: index === 0 ? 1 : 0, f1: index === 1 ? 1 : 0, f2: 0, abstain: 0 },
                    },
                ])
            )
        );
    };
    const result = await navigateFolders({
        ...fixture,
        names: ["agent configuration", "documentation"],
        mode: "open",
        evaluate,
    });
    expect(result.status).toBe("verified");
    expect(requests).toBe(1);
    expect(result.metrics.requests).toBe(1);
    const uncertain = folderFixture();
    const stopped = await navigateFolders({
        ...uncertain,
        names: ["unclear"],
        mode: "open",
        evaluate: async () =>
            evaluation({
                q0: { type: "choice", choice: "f0", probabilities: { f0: 0.5, f1: 0.5, f2: 0, abstain: 0 } },
            }),
    });
    expect(stopped.status).toBe("stopped");
    expect(uncertain.calls).toHaveLength(0);
});
test("folder sequences stop on uncertain delivery and never double-toggle", async () => {
    const fixture = folderFixture();
    let attempts = 0;
    fixture.driver.set = async () => {
        attempts++;
        return { ok: false, dispatchState: "uncertain", error: "transport lost" };
    };
    const result = await navigateFolders({
        ...fixture,
        names: ["agents", "docs"],
        mode: "peek",
        evaluate: chooseFirst,
    });
    expect(result.status).toBe("unknown");
    expect(attempts).toBe(1);
});
test("folder sequences reject duplicate targets, cancellation and budget overflow before dispatch", async () => {
    for (const extra of [
        { names: ["agents", "agents"] },
        { names: ["agents"], signal: AbortSignal.abort() },
        { names: ["agents", "docs"], limits: { maxActions: 1 } },
    ]) {
        const fixture = folderFixture();
        const result = await navigateFolders({ ...fixture, ...extra, mode: "open", evaluate: chooseFirst });
        expect(result.status).toBe("stopped");
        expect(fixture.calls).toHaveLength(0);
    }
});
