import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as realPrompts from "@clack/prompts";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";
import { executeBuiltin } from "./builtins";
import { saveCredential } from "./credentials";
import type { RunLogger } from "./run-logger";
import * as realStepRunner from "./step-runner.ts";
import * as realStorage from "./storage.ts";
import type { ExecutionContext, Preset, PresetStep, StepHandlerResult, StepResult } from "./types";

const ctx: ExecutionContext = { vars: {}, steps: {}, env: {} };

/** What the fake step executor saw for one step: the step id, the dry-run flag and a copy of the context. */
interface ExecutedStep {
    id: string;
    dryRun: boolean | undefined;
    vars: Record<string, string | number | boolean>;
    finishedBefore: string[];
}

type StepScript = (step: PresetStep) => StepHandlerResult | Promise<StepHandlerResult>;

const CANCELLED = Symbol("cancelled");
const executed: ExecutedStep[] = [];
const scripts = new Map<string, StepScript>();
const promptCalls: Array<{ message: string; placeholder?: string }> = [];
const promptAnswers: unknown[] = [];
const logLines: Array<{ level: string; message: string }> = [];
const spinnerStops: string[] = [];
const metaCalls: string[] = [];
let metaFails = false;

/** Records the text a reader sees: picocolors colors its output whenever `CI` is set, so CI and a local run differ only in escape codes. */
function logSink(level: string): (message: string) => void {
    return (message) => {
        logLines.push({ level, message: stripAnsi(message) });
    };
}

mock.module("@clack/prompts", () => ({
    ...realPrompts,
    log: {
        ...realPrompts.log,
        warn: logSink("warn"),
        step: logSink("step"),
        info: logSink("info"),
        error: logSink("error"),
    },
    spinner: () => ({
        start: () => {},
        stop: (message: string) => {
            spinnerStops.push(message);
        },
        message: () => {},
    }),
    text: async (options: { message: string; placeholder?: string }) => {
        promptCalls.push({ message: options.message, placeholder: options.placeholder });
        return promptAnswers.shift();
    },
    isCancel: (value: unknown) => value === CANCELLED,
    cancel: logSink("cancel"),
}));

mock.module("./step-runner.ts", () => ({
    ...realStepRunner,
    executeStep: async (
        step: PresetStep,
        stepCtx: ExecutionContext,
        options: { dryRun?: boolean }
    ): Promise<StepHandlerResult> => {
        executed.push({
            id: step.id,
            dryRun: options.dryRun,
            vars: { ...stepCtx.vars },
            finishedBefore: Object.keys(stepCtx.steps),
        });

        const script = scripts.get(step.id);

        if (script) {
            return script(step);
        }

        return { result: { status: "success", output: `${step.id}-output`, duration: 3 } };
    },
}));

mock.module("./storage.ts", () => ({
    ...realStorage,
    updatePresetMeta: async (presetName: string) => {
        if (metaFails) {
            throw new Error("meta store offline");
        }

        metaCalls.push(presetName);
    },
}));

const { runPreset } = await import("./engine.ts");

describe("credential persistence", () => {
    test.each([
        '{"token":',
        "null",
        "[]",
        "{}",
        '{"name":"fixture","type":"unknown"}',
        '{"name":42,"type":"bearer"}',
        '{"type":"basic"}',
        '{"name":"fixture"}',
        '{"name":"fixture","type":"bearer","token":{"recoverable":"fixture-value"}}',
        '{"name":"fixture","type":"custom","headers":"not-an-object"}',
        '{"name":"fixture","type":"custom","headers":{"x-fixture":1}}',
        '{"name":"fixture","type":["bearer"],"token":"fixture-value"}',
    ])("preserves damaged credential bytes before saving: %s", async (damaged) => {
        const name = `fixture-${crypto.randomUUID()}`;
        const credential = { name, type: "bearer" as const, token: "fixture-token" };
        const dir = join(env.tools.getHome(), ".genesis-tools", "automate", "credentials");
        const path = join(dir, `${name}.json`);
        try {
            await saveCredential(credential);
            writeFileSync(path, damaged);
            await saveCredential({ ...credential, token: "replacement-token" });
            const copies = readdirSync(dir).filter((file) => file.startsWith(`${name}.json.corrupt-`));
            expect(copies).toHaveLength(1);
            expect(readFileSync(join(dir, copies[0]), "utf8")).toBe(damaged);
            expect(statSync(join(dir, copies[0])).mode & 0o777).toBe(0o600);
            expect(SafeJSON.parse(readFileSync(path, "utf8")).token).toBe("replacement-token");
        } finally {
            for (const file of readdirSync(dir).filter((file) => file.startsWith(`${name}.json`))) {
                rmSync(join(dir, file));
            }
        }
    });

    test.each(["bearer", "basic", "apikey", "custom"] as const)(
        "a valid %s credential without optional fields can be updated without making a corrupt copy",
        async (type) => {
            const name = `fixture-${crypto.randomUUID()}`;
            const dir = join(env.tools.getHome(), ".genesis-tools", "automate", "credentials");
            const path = join(dir, `${name}.json`);
            try {
                await saveCredential({ name, type });
                await saveCredential({ name, type, token: "second-token" });
                expect(SafeJSON.parse(readFileSync(path, "utf8")).token).toBe("second-token");
                expect(readdirSync(dir).filter((file) => file.startsWith(`${name}.json.corrupt-`))).toEqual([]);
                expect(statSync(path).mode & 0o777).toBe(0o600);
            } finally {
                rmSync(path, { force: true });
            }
        }
    );
});

describe("handleShell timeout cleanup", () => {
    test("the spawned process is confirmed exited before the timeout error propagates", async () => {
        const marker = `automate-shell-sleep-${Date.now()}`;

        try {
            await executeBuiltin(
                {
                    id: "timeout-test",
                    name: "timeout test",
                    action: "shell",
                    params: { command: `exec -a ${marker} sleep 30`, timeout: 1 },
                },
                ctx
            );
            throw new Error("expected timeout");
        } catch (err) {
            expect(String(err)).toContain("timed out");
        }

        await new Promise((r) => setTimeout(r, 200));
        const after = Bun.spawnSync(["pgrep", "-f", marker], { env: process.env }).stdout.toString().trim();
        expect(after).toBe("");
    });
});

function step(id: string, overrides: Partial<PresetStep> = {}): PresetStep {
    return { id, name: `Step ${id}`, action: "log", ...overrides };
}

function makePreset(steps: PresetStep[], overrides: Partial<Preset> = {}): Preset {
    return { $schema: "automate/v1", name: "fixture-preset", trigger: { type: "manual" }, steps, ...overrides };
}

function result(status: StepResult["status"], extra: Partial<StepResult> = {}): StepHandlerResult {
    return { result: { status, output: null, duration: 1, ...extra } };
}

function executedIds(): string[] {
    return executed.map((entry) => entry.id);
}

function fakeLogger(): RunLogger & {
    steps: Array<{ index: number; id: string; name: string; action: string; status: StepResult["status"] }>;
    finished: Array<{ success: boolean; stepCount: number; error?: string }>;
} {
    const steps: Array<{ index: number; id: string; name: string; action: string; status: StepResult["status"] }> = [];
    const finished: Array<{ success: boolean; stepCount: number; error?: string }> = [];

    return {
        runId: 7,
        steps,
        finished,
        async logStep(index, id, name, action, stepResult) {
            steps.push({ index, id, name, action, status: stepResult.status });
        },
        async finishRun(success, stepCount, _totalDuration, error) {
            finished.push({ success, stepCount, error });
        },
    };
}

describe("runPreset", () => {
    beforeEach(() => {
        executed.length = 0;
        scripts.clear();
        promptCalls.length = 0;
        promptAnswers.length = 0;
        logLines.length = 0;
        spinnerStops.length = 0;
        metaCalls.length = 0;
        metaFails = false;
    });

    test("runs the steps in order and lets each step see the results of the earlier ones", async () => {
        const preset = makePreset([step("first"), step("second"), step("third")]);

        const outcome = await runPreset(preset);

        expect(outcome.preset).toBe("fixture-preset");
        expect(outcome.success).toBe(true);
        expect(outcome.steps.map((entry) => entry.id)).toEqual(["first", "second", "third"]);
        expect(outcome.steps[1].name).toBe("Step second");
        expect(outcome.steps[0].result.output).toBe("first-output");
        expect(executed.map((entry) => entry.finishedBefore)).toEqual([[], ["first"], ["first", "second"]]);
        expect(outcome.totalDuration).toBeGreaterThanOrEqual(0);
    });

    test("never reaches a real tool: every step goes to the fake executor, non-dry", async () => {
        await runPreset(makePreset([step("a", { action: "shell", params: { command: "exit 99" } }), step("b")]));

        expect(executed.map((entry) => [entry.id, entry.dryRun])).toEqual([
            ["a", false],
            ["b", false],
        ]);
    });

    test("preset defaults seed the variables and --var overrides win, keeping everything after the first =", async () => {
        const preset = makePreset([step("only")], {
            vars: {
                region: { type: "string", description: "Region", default: "eu" },
                retries: { type: "number", description: "Retries", default: 3 },
            },
        });

        await runPreset(preset, { vars: ["region=us", "query=a=b", "empty="] });

        expect(executed[0].vars).toEqual({ region: "us", retries: 3, query: "a=b", empty: "" });
    });

    test("a --var without an equals sign is reported and ignored", async () => {
        await runPreset(makePreset([step("only")]), { vars: ["novalue"] });

        expect(executed[0].vars).toEqual({});
        expect(logLines.find((line) => line.level === "warn")?.message).toContain(
            'Invalid --var format: "novalue" (expected key=value)'
        );
    });

    test("required variables without a value are prompted and coerced to their declared type", async () => {
        const preset = makePreset([step("only")], {
            vars: {
                count: { type: "number", description: "How many" },
                verbose: { type: "boolean", description: "Verbose?" },
                label: { type: "string", description: "", default: undefined },
            },
        });
        promptAnswers.push("42", "true", "hello");

        await runPreset(preset);

        expect(promptCalls.map((call) => call.message)).toEqual(["How many", "Verbose?", 'Enter value for "label":']);
        expect(executed[0].vars).toEqual({ count: 42, verbose: true, label: "hello" });
    });

    test("a boolean answer other than true becomes false", async () => {
        const preset = makePreset([step("only")], { vars: { flag: { type: "boolean", description: "Flag" } } });
        promptAnswers.push("nope");

        await runPreset(preset);

        expect(executed[0].vars.flag).toBe(false);
    });

    test("variables with a default, a --var value or required:false are never prompted", async () => {
        const preset = makePreset([step("only")], {
            vars: {
                withDefault: { type: "string", description: "A", default: "x" },
                fromCli: { type: "string", description: "B" },
                optional: { type: "string", description: "C", required: false },
            },
        });

        await runPreset(preset, { vars: ["fromCli=y"] });

        expect(promptCalls).toEqual([]);
        expect(executed[0].vars).toEqual({ withDefault: "x", fromCli: "y" });
    });

    test("cancelling a variable prompt exits the process before any step runs", async () => {
        const preset = makePreset([step("only")], { vars: { needed: { type: "string", description: "Needed" } } });
        promptAnswers.push(CANCELLED);
        const exit = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
            throw new Error(`exit:${code}`);
        });

        try {
            await expect(runPreset(preset)).rejects.toThrow("exit:0");
            expect(exit).toHaveBeenCalledWith(0);
        } finally {
            exit.mockRestore();
        }

        expect(logLines).toContainEqual({ level: "cancel", message: "Operation cancelled" });
        expect(executed).toEqual([]);
    });

    test("onError stop (the default) halts at the first failed step and reports the run as failed", async () => {
        scripts.set("second", () => result("error", { error: "boom", exitCode: 2 }));
        const logger = fakeLogger();

        const outcome = await runPreset(makePreset([step("first"), step("second"), step("third")]), {}, logger);

        expect(executedIds()).toEqual(["first", "second"]);
        expect(outcome.success).toBe(false);
        expect(outcome.steps.map((entry) => entry.result.status)).toEqual(["success", "error"]);
        expect(logLines.map((line) => line.message)).toContain("boom");
        expect(logLines.map((line) => line.message)).toContain(
            "Stopping execution due to step failure (onError: stop)"
        );
        expect(logger.finished).toEqual([{ success: false, stepCount: 2, error: "boom" }]);
    });

    test.each(["continue", "skip"] as const)(
        "onError %s moves on to the next step but the run still fails",
        async (strategy) => {
            scripts.set("second", () => result("error", { error: "flaky" }));

            const outcome = await runPreset(
                makePreset([step("first"), step("second", { onError: strategy }), step("third")])
            );

            expect(executedIds()).toEqual(["first", "second", "third"]);
            expect(outcome.success).toBe(false);
            expect(outcome.steps.map((entry) => entry.result.status)).toEqual(["success", "error", "success"]);
        }
    );

    test("a skipped step does not fail the run", async () => {
        scripts.set("second", () => result("skipped", { output: "not needed" }));

        const outcome = await runPreset(makePreset([step("first"), step("second")]));

        expect(outcome.success).toBe(true);
    });

    test("an error without a message does not log an empty line", async () => {
        scripts.set("first", () => result("error"));

        await runPreset(makePreset([step("first")]));

        expect(logLines.filter((line) => line.level === "error").map((line) => line.message)).toEqual([
            "Stopping execution due to step failure (onError: stop)",
        ]);
    });

    test("a thrown executor error becomes an error result that later steps can read", async () => {
        scripts.set("first", () => {
            throw new Error("spawn failed");
        });
        const logger = fakeLogger();

        const outcome = await runPreset(
            makePreset([step("first", { onError: "continue" }), step("second")]),
            {},
            logger
        );

        expect(executedIds()).toEqual(["first", "second"]);
        expect(outcome.steps[0].result).toEqual({ status: "error", output: null, duration: 0, error: "spawn failed" });
        expect(executed[1].finishedBefore).toEqual(["first"]);
        expect(spinnerStops[0]).toContain("EXCEPTION");
        expect(logger.steps.map((entry) => [entry.id, entry.status])).toEqual([
            ["first", "error"],
            ["second", "success"],
        ]);
        expect(logger.finished[0]).toEqual({ success: false, stepCount: 2, error: "spawn failed" });
    });

    test("a thrown non-Error value is stringified and stops the run by default", async () => {
        scripts.set("first", () => {
            throw "plain string failure";
        });

        const outcome = await runPreset(makePreset([step("first"), step("second")]));

        expect(executedIds()).toEqual(["first"]);
        expect(outcome.steps[0].result.error).toBe("plain string failure");
        expect(outcome.success).toBe(false);
    });

    test("a jump skips the steps in between and lands on the target step", async () => {
        scripts.set("gate", () => ({ ...result("success"), jumpTo: "finish" }));

        const outcome = await runPreset(
            makePreset([step("gate"), step("skipped-1"), step("skipped-2"), step("finish")])
        );

        expect(executedIds()).toEqual(["gate", "finish"]);
        expect(outcome.success).toBe(true);
    });

    test("a jump back to an earlier step runs it again", async () => {
        let visits = 0;
        scripts.set("check", () => {
            visits++;
            return visits === 1 ? { ...result("success"), jumpTo: "prepare" } : result("success");
        });

        await runPreset(makePreset([step("prepare"), step("check"), step("done")]));

        expect(executedIds()).toEqual(["prepare", "check", "prepare", "check", "done"]);
    });

    test("a jump to an unknown step ends the run after reporting the missing target", async () => {
        scripts.set("gate", () => ({ ...result("success"), jumpTo: "nowhere" }));

        const outcome = await runPreset(makePreset([step("gate"), step("after")]));

        expect(executedIds()).toEqual(["gate"]);
        expect(spinnerStops.at(-1)).toContain('jump target "nowhere" not found');
        expect(outcome.steps.map((entry) => entry.id)).toEqual(["gate"]);
    });

    test("a failed step does not follow its jump when it stops the run", async () => {
        scripts.set("gate", () => ({ ...result("error", { error: "no" }), jumpTo: "finish" }));

        await runPreset(makePreset([step("gate"), step("middle"), step("finish")]));

        expect(executedIds()).toEqual(["gate"]);
    });

    test("steps owned by a parallel step are left to its handler", async () => {
        const preset = makePreset([
            step("fan-out", { action: "parallel", params: { steps: ["left", "right"] } }),
            step("left"),
            step("right"),
            step("after"),
        ]);

        const outcome = await runPreset(preset);

        expect(executedIds()).toEqual(["fan-out", "after"]);
        expect(outcome.steps.map((entry) => entry.id)).toEqual(["fan-out", "after"]);
    });

    test("a parallel step without a steps list claims no children", async () => {
        const preset = makePreset([step("fan-out", { action: "parallel" }), step("solo")]);

        await runPreset(preset);

        expect(executedIds()).toEqual(["fan-out", "solo"]);
    });

    test("a dry run asks the executor for a dry run, prints its text, and leaves no run record", async () => {
        scripts.set("first", () => result("skipped", { output: "Would run: tools github search" }));
        scripts.set("second", () => result("skipped", { output: { structured: true } }));
        const logger = fakeLogger();

        const outcome = await runPreset(makePreset([step("first"), step("second")]), { dryRun: true }, logger);

        expect(executed.map((entry) => entry.dryRun)).toEqual([true, true]);
        expect(outcome.success).toBe(true);
        expect(logLines.map((line) => `${line.level}:${line.message.trim()}`)).toEqual([
            "warn:DRY RUN -- no commands will be executed",
            "step:[1/2] Step first",
            "info:Would run: tools github search",
            "step:[2/2] Step second",
        ]);
        expect(logger.steps).toEqual([]);
        expect(metaCalls).toEqual([]);
        expect(spinnerStops).toEqual([]);
    });

    test("a real run labels each step by position and total, with its duration on success", async () => {
        scripts.set("first", () => result("success", { duration: 2500 }));

        await runPreset(makePreset([step("first"), step("second")]));

        expect(spinnerStops[0]).toContain("[1/2] Step first (2.5s)");
        expect(spinnerStops[1]).toContain("[2/2] Step second");
    });

    test("a failed step is labelled FAILED on its spinner", async () => {
        scripts.set("first", () => result("error", { error: "denied" }));

        await runPreset(makePreset([step("first")]));

        expect(spinnerStops[0]).toContain("[1/1] Step first FAILED");
    });

    test("the run logger gets every step with its index, id, name and action, then one finish call", async () => {
        const logger = fakeLogger();
        const preset = makePreset([step("one", { action: "set" }), step("two", { action: "http.get" })]);

        await runPreset(preset, {}, logger);

        expect(logger.steps).toEqual([
            { index: 0, id: "one", name: "Step one", action: "set", status: "success" },
            { index: 1, id: "two", name: "Step two", action: "http.get", status: "success" },
        ]);
        expect(logger.finished).toEqual([{ success: true, stepCount: 2, error: undefined }]);
    });

    test("the run counter is bumped once per real run", async () => {
        await runPreset(makePreset([step("only")], { name: "nightly" }));

        expect(metaCalls).toEqual(["nightly"]);
    });

    test("a metadata failure never fails the run", async () => {
        metaFails = true;

        const outcome = await runPreset(makePreset([step("only")]));

        expect(outcome.success).toBe(true);
        expect(metaCalls).toEqual([]);
    });
});

describe("bundled presets", () => {
    const presetsDir = resolve(import.meta.dir, "../presets");
    const presetFiles = readdirSync(presetsDir).filter((file) => file.endsWith(".json"));

    beforeEach(() => {
        executed.length = 0;
        scripts.clear();
        logLines.length = 0;
        spinnerStops.length = 0;
        metaCalls.length = 0;
    });

    test("the bundled folder is not empty", () => {
        expect(presetFiles.length).toBeGreaterThan(0);
    });

    test.each(presetFiles)("%s validates and runs end to end against the fake executor", async (file) => {
        const { loadPreset } = realStorage;
        const preset = await loadPreset(join(presetsDir, file));
        const requiredVars = Object.entries(preset.vars ?? {})
            .filter(([, def]) => def.default === undefined && def.required !== false)
            .map(([key]) => `${key}=fixture`);
        const parallelChildren = new Set(
            preset.steps.flatMap((s) =>
                s.action === "parallel" ? ((s.params?.steps as string[] | undefined) ?? []) : []
            )
        );

        const outcome = await runPreset(preset, { vars: requiredVars });

        expect(outcome.success).toBe(true);
        expect(executedIds()).toEqual(preset.steps.map((s) => s.id).filter((id) => !parallelChildren.has(id)));
        expect(executed.every((entry) => entry.dryRun === false)).toBe(true);
    });
});
