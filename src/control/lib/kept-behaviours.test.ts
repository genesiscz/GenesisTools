/**
 * Regression tests for the `tools control` behaviours that were verified working on 2026-09-09 and must
 * survive the focus-safety work (handoff h_00ddcbx1 t23). ax-tool is a scripted fake
 * (`__fixtures__/fake-ax.ts`); images are generated PNGs in a temp folder. Nothing touches the real Mac.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { fakeAx, runCli, solidPng } from "./__fixtures__/fake-ax";
import type { AxResult } from "./runner";
import * as runner from "./runner";

let native = fakeAx();
mock.module("./runner", () => ({ ...runner, runAx: (args: string[]) => native.run(args) }));

const { assertEl, conditionExitCode, waitFor } = await import("./conditions");
const { executePlan, DEFAULT_PLAN_RUN_DEPS } = await import("./plan-runner");
const { registerDiscoveryCommands } = await import("../commands/discovery");
const { registerInteractCommands } = await import("../commands/interact");
const { registerStateCommands } = await import("../commands/state");
const { registerDrawCommand } = await import("../commands/draw");
const { registerCompareScreenshotCommand } = await import("../commands/compare-screenshot");
const { registerVerifyCommands } = await import("../commands/verify");

const dir = mkdtempSync(join(tmpdir(), "gt-control-kept-"));

afterAll(() => {
    mock.restore();
});

beforeEach(() => {
    native = fakeAx();
});

function element(value: unknown, extra: Record<string, unknown> = {}): AxResult {
    return { ok: true, role: "AXTextField", value, enabled: true, focused: false, ...extra };
}

describe("wait", () => {
    test("--gone passes once the element stops resolving", async () => {
        native = fakeAx((_args, call) => (call < 3 ? element("x") : { ok: false, error: "element not found" }));
        const result = await waitFor({
            app: "Fixture",
            target: ["--id", "spinner"],
            gone: true,
            timeout: 2000,
            interval: 1,
            run: native.run,
        });

        expect(result.ok).toBe(true);
        expect(result.gone).toBe(true);
        expect(result.polls).toBe(3);
        expect(native.calls[0]).toEqual(["get", "--app", "Fixture", "--id", "spinner"]);
    });

    test("--for enabled waits for the enabled state, not mere existence", async () => {
        native = fakeAx((_args, call) => element("", { enabled: call >= 2 }));
        const result = await waitFor({
            app: "Fixture",
            target: ["--q", "Save"],
            for: "enabled",
            timeout: 2000,
            interval: 1,
            run: native.run,
        });

        expect(result.ok).toBe(true);
        expect(result.polls).toBe(2);
    });

    test("--contains matches a substring of AXValue", async () => {
        native = fakeAx((_args, call) => element(call >= 2 ? "Build finished" : "Building"));
        const result = await waitFor({
            app: "Fixture",
            target: ["--id", "status"],
            contains: "finished",
            timeout: 2000,
            interval: 1,
            run: native.run,
        });

        expect(result.ok).toBe(true);
    });

    test("a timeout error names the condition and carries lastState", async () => {
        native = fakeAx(() => element("Building"));
        const result = await waitFor({
            app: "Fixture",
            target: ["--id", "status"],
            contains: "finished",
            timeout: 30,
            interval: 5,
            run: native.run,
        });

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain("timeout after 30ms");
        expect(String(result.error)).toContain("value contains 'finished'");
        expect(result.lastState).toEqual(element("Building"));
    });
});

describe("assert", () => {
    test("exit code 0 when the condition holds and 1 when it does not, with the actual value", async () => {
        native = fakeAx(() => element("Done"));
        const pass = await assertEl({ app: "Fixture", target: ["--id", "status"], value: "Done", run: native.run });
        const fail = await assertEl({ app: "Fixture", target: ["--id", "status"], value: "Other", run: native.run });

        expect(conditionExitCode(pass)).toBe(0);
        expect(conditionExitCode(fail)).toBe(1);
        expect(fail.actual).toEqual({ value: "Done", enabled: true, focused: false });
    });

    test("the CLI assert exits 1 on a failed condition and 0 on a held one", async () => {
        native = fakeAx(() => element("Done"));
        const held = await runCli(registerVerifyCommands, [
            "assert",
            "--app",
            "Fixture",
            "--id",
            "status",
            "--expect",
            "Done",
            "--json",
        ]);
        const failed = await runCli(registerVerifyCommands, [
            "assert",
            "--app",
            "Fixture",
            "--id",
            "status",
            "--expect",
            "No",
            "--json",
        ]);

        expect(held.code).toBe(0);
        expect(failed.code).toBe(1);
    });
});

describe("find, get, attrs, actions", () => {
    test("each passes its selector flags to ax-tool and exits by the result", async () => {
        native = fakeAx(() => ({ ok: true, app: "Fixture", matches: [], attributes: {}, actions: [], count: 0 }));

        expect(
            (
                await runCli(registerDiscoveryCommands, [
                    "find",
                    "--app",
                    "Fixture",
                    "--role",
                    "button",
                    "--q",
                    "Save",
                    "--json",
                ])
            ).code
        ).toBe(0);
        expect(
            (await runCli(registerInteractCommands, ["get", "--app", "Fixture", "--id", "name", "--json"])).code
        ).toBe(0);
        expect(
            (await runCli(registerDiscoveryCommands, ["attrs", "--app", "Fixture", "--desc", "Close", "--json"])).code
        ).toBe(0);
        expect(
            (await runCli(registerDiscoveryCommands, ["actions", "--app", "Fixture", "--title", "OK", "--json"])).code
        ).toBe(0);

        expect(native.calls).toEqual([
            ["find", "--app", "Fixture", "--role", "button", "--q", "Save", "--depth", "15"],
            ["get", "--app", "Fixture", "--id", "name"],
            ["attrs", "--app", "Fixture", "--desc", "Close"],
            ["actions", "--app", "Fixture", "--title", "OK"],
        ]);
    });

    test("a native failure exits 1", async () => {
        native = fakeAx(() => ({ ok: false, error: "element not found" }));

        expect(
            (await runCli(registerInteractCommands, ["get", "--app", "Fixture", "--id", "gone", "--json"])).code
        ).toBe(1);
    });
});

describe("window", () => {
    test("--no-raise reaches ax-tool, and a plain listing raises nothing", async () => {
        native = fakeAx(() => ({ ok: true, action: "move", windows: [] }));
        await runCli(registerDiscoveryCommands, [
            "window",
            "--app",
            "Fixture",
            "--action",
            "move",
            "--x",
            "10",
            "--y",
            "20",
            "--no-raise",
        ]);
        await runCli(registerDiscoveryCommands, ["window", "--app", "Fixture"]);

        expect(native.calls).toEqual([
            ["window", "--app", "Fixture", "--action", "move", "--x", "10", "--y", "20", "--no-raise"],
            ["window", "--app", "Fixture"],
        ]);
    });
});

describe("screenshot and ocr", () => {
    test("screenshot passes --window, --crop and --annotate, and reports the numbered legend", async () => {
        native = fakeAx(() => ({
            ok: true,
            window: "Doc",
            width: 10,
            height: 10,
            path: "/x.png",
            annotations: [{ n: 1 }, { n: 2 }],
        }));
        const run = await runCli(registerInteractCommands, [
            "screenshot",
            "--app",
            "Fixture",
            "--path",
            "/x.png",
            "--window",
            "Doc",
            "--crop",
            "0,0,5,5",
            "--annotate",
        ]);

        expect(native.calls[0]).toEqual([
            "screenshot",
            "--app",
            "Fixture",
            "--path",
            "/x.png",
            "--window",
            "Doc",
            "--crop",
            "0,0,5,5",
            "--annotate",
        ]);
        expect(run.stdout.join("\n")).toContain("2 annotated elements");
    });

    test("ocr reads an app, a window, a crop and an image file", async () => {
        native = fakeAx(() => ({ ok: true, app: "Fixture", window: "Doc", blocks: [{ text: "Hello" }] }));
        await runCli(registerInteractCommands, ["ocr", "--app", "Fixture", "--window", "Doc", "--crop", "1,2,3,4"]);
        await runCli(registerInteractCommands, ["ocr", "--image", "/shot.png"]);
        const missing = await runCli(registerInteractCommands, ["ocr"]);

        expect(native.calls).toEqual([
            ["ocr", "--app", "Fixture", "--window", "Doc", "--crop", "1,2,3,4"],
            ["ocr", "--image", "/shot.png"],
        ]);
        expect(missing.code).toBe(1);
    });
});

describe("snapshot and restore", () => {
    test("restore hands the snapshot JSON back to ax-tool unchanged", async () => {
        const snapshot = { ok: true, app: "Fixture", mouse: { x: 1, y: 2 } };
        native = fakeAx(() => snapshot);
        await runCli(registerStateCommands, ["snapshot", "--json"]);
        await runCli(registerStateCommands, ["restore", "--snapshot", SafeJSON.stringify(snapshot)]);

        expect(native.calls).toEqual([["snapshot"], ["restore", "--snapshot", SafeJSON.stringify(snapshot)]]);
    });
});

describe("draw and compare-screenshot", () => {
    const a = join(dir, "a.png");
    const same = join(dir, "same.png");
    const changed = join(dir, "changed.png");
    const small = join(dir, "small.png");

    test("fixtures", async () => {
        await Bun.write(a, solidPng({ width: 40, height: 40, color: [255, 255, 255] }));
        await Bun.write(same, solidPng({ width: 40, height: 40, color: [255, 255, 255] }));
        await Bun.write(
            changed,
            solidPng({
                width: 40,
                height: 40,
                color: [255, 255, 255],
                patch: { x: 0, y: 0, w: 20, h: 20, color: [0, 0, 0] },
            })
        );
        await Bun.write(small, solidPng({ width: 20, height: 20, color: [255, 255, 255] }));
    });

    test("draw writes an annotated copy and never mutates the input", async () => {
        const before = await Bun.file(a).bytes();
        const output = join(dir, "drawn.png");
        const run = await runCli(registerDrawCommand, [
            "draw",
            a,
            "--annotate",
            '{"annotations":[{"kind":"box","rect":{"x":2,"y":2,"w":10,"h":10}}]}',
            "--out",
            output,
            "--json",
        ]);

        expect(run.code).toBe(0);
        expect(await Bun.file(output).exists()).toBe(true);
        expect(await Bun.file(a).bytes()).toEqual(before);
    });

    test("--max-mismatch gates exit 1 over the limit and 0 within it", async () => {
        const over = await runCli(registerCompareScreenshotCommand, [
            "compare-screenshot",
            a,
            changed,
            "--max-mismatch",
            "1",
            "--json",
        ]);
        const within = await runCli(registerCompareScreenshotCommand, [
            "compare-screenshot",
            a,
            same,
            "--max-mismatch",
            "1",
            "--json",
        ]);

        expect(over.code).toBe(1);
        expect(SafeJSON.parse(over.stdout[0] ?? "{}").mismatchPct).toBe(25);
        expect(within.code).toBe(0);
    });

    test("a size mismatch is unusable input (exit 2) unless --resize-to-match scales B onto A", async () => {
        const refused = await runCli(registerCompareScreenshotCommand, ["compare-screenshot", a, small, "--json"]);
        const resized = await runCli(registerCompareScreenshotCommand, [
            "compare-screenshot",
            a,
            small,
            "--resize-to-match",
            "--json",
        ]);

        expect(refused.code).toBe(2);
        expect(resized.code).toBe(0);
        expect(SafeJSON.parse(resized.stdout[0] ?? "{}").resized).toBe(true);
    });
});

describe("the plan runner", () => {
    const deps = (run: (args: string[]) => AxResult) => ({
        ...DEFAULT_PLAN_RUN_DEPS,
        run,
        sleep: async () => {},
        guard: async () => null,
    });

    test("every step carries its ms, and failedSteps counts the failures", async () => {
        native = fakeAx((args) => (args[0] === "press" ? { ok: false, error: "element not found" } : { ok: true }));
        const outcome = await executePlan({
            plan: {
                app: "Fixture",
                steps: [
                    { do: "get", id: "a" },
                    { do: "press", q: "Missing" },
                    { do: "get", id: "b" },
                ],
            },
            deps: deps(native.run),
        });

        expect(outcome.kind).toBe("ran");
        if (outcome.kind !== "ran") {
            return;
        }

        expect(outcome.report.failedSteps).toBe(1);
        expect(outcome.report.totalSteps).toBe(3);
        expect(outcome.report.ok).toBe(false);
        expect(outcome.report.steps.every((step) => typeof step.ms === "number")).toBe(true);
        expect(native.calls.map((call) => call[0])).toEqual(["get", "press", "get"]);
    });

    test("stopOnFail skips the rest, and a skipped step is not counted as failed", async () => {
        native = fakeAx((args) => (args[0] === "press" ? { ok: false, error: "element not found" } : { ok: true }));
        const outcome = await executePlan({
            plan: {
                app: "Fixture",
                stopOnFail: true,
                steps: [
                    { do: "press", q: "Missing" },
                    { do: "get", id: "b" },
                ],
            },
            deps: deps(native.run),
        });

        expect(outcome.kind === "ran" && outcome.report.stoppedAtStep).toBe(1);
        expect(outcome.kind === "ran" && outcome.report.skippedSteps).toBe(1);
        expect(outcome.kind === "ran" && outcome.report.failedSteps).toBe(1);
        expect(native.calls).toHaveLength(1);
    });

    test("a focus-steal refusal fails the step without dispatching it", async () => {
        native = fakeAx();
        const outcome = await executePlan({
            plan: { app: "Fixture", steps: [{ do: "type", text: "secret" }] },
            deps: { ...deps(native.run), guard: async () => ({ ok: false, error: "refused", refusal: "focus_steal" }) },
        });

        expect(outcome.kind === "ran" && outcome.report.failedSteps).toBe(1);
        expect(native.calls).toHaveLength(0);
    });

    test("cancellation during a step skips every later action and restore", async () => {
        const controller = new AbortController();
        native = fakeAx((args) => {
            if (args[0] === "get") {
                controller.abort();
            }
            return { ok: true };
        });
        const outcome = await executePlan({
            plan: {
                app: "Fixture",
                restore: true,
                steps: [
                    { do: "get", id: "a" },
                    { do: "press", id: "b" },
                ],
            },
            signal: controller.signal,
            deps: deps(native.run),
        });

        expect(native.calls.map((call) => call[0])).toEqual(["snapshot", "get"]);
        expect(outcome.kind === "ran" && outcome.report.ok).toBe(false);
        expect(outcome.kind === "ran" && outcome.report.skippedSteps).toBe(1);
    });

    test("cancellation interrupts the delay before a later action", async () => {
        const controller = new AbortController();
        native = fakeAx();
        const running = executePlan({
            plan: {
                app: "Fixture",
                steps: [
                    { do: "get", id: "a" },
                    { do: "press", id: "b" },
                ],
            },
            signal: controller.signal,
            deps: { ...deps(native.run), sleep: () => new Promise<void>(() => {}) },
        });
        setTimeout(() => controller.abort(), 10);
        const outcome = await running;
        expect(native.calls.map((call) => call[0])).toEqual(["get"]);
        expect(outcome.kind === "ran" && outcome.report.skippedSteps).toBe(1);
    });

    test("a cancellable plan refuses the synchronous recording backend before dispatch", async () => {
        native = fakeAx();
        const outcome = await executePlan({
            plan: {
                app: "Fixture",
                capture: { backend: "peekaboo", mode: "screen", duration: 1 },
                steps: [{ do: "type", text: "test" }],
            },
            signal: new AbortController().signal,
            deps: {
                ...deps(native.run),
                capture: async () => {
                    throw new Error("capture must not start");
                },
            },
        });
        expect(outcome.kind).toBe("invalid");
        expect(native.calls).toHaveLength(0);
    });

    test("restore snapshots before the first step and restores after the last", async () => {
        native = fakeAx((args) => (args[0] === "snapshot" ? { ok: true, app: "Fixture" } : { ok: true }));
        await executePlan({
            plan: { app: "Fixture", restore: true, steps: [{ do: "get", id: "a" }] },
            deps: deps(native.run),
        });

        expect(native.calls.map((call) => call[0])).toEqual(["snapshot", "get", "restore"]);
    });
});
