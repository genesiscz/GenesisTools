import { addProviderOption, selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator, type Evaluator, evaluateRequest } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { judgeOutcome, resolveIntent } from "../lib/decision/decisions";
import { type ControlDriver, NativeControlDriver } from "../lib/decision/native";
import { observationSchema } from "../lib/decision/observation";
import { setCursorFeedbackEnabled } from "../lib/runner";
import { SimulatorControlDriver } from "../lib/simulator/driver";

export interface ControlOptions {
    app?: string;
    windowId?: string;
    scope?: string | boolean;
    image?: boolean;
    snapshotFile?: string;
    timeout: string;
    exactId?: string;
    exactValue?: string;
    simulator?: string | boolean;
    bundleId?: string;
}
export function observationOptions(command: Command): Command {
    return command
        .option("--app <name>", "Target app name or PID")
        .option("--window-id <id>", "Pin to a native window ID")
        .option("--scope [scope]", "AX scope: window or chrome", "window")
        .option("--simulator [udid]", "Observe a booted iOS Simulator instead of a macOS window")
        .option("--bundle-id <id>", "With --simulator: the app under test, e.g. com.apple.mobilecal")
        .option("--timeout <ms>", "Total deadline in milliseconds", "120000");
}
/**
 * The one place a surface is chosen. `--simulator` swaps the macOS AX driver for the iOS one;
 * everything above this call (the admission gate, Jev's classification, freshness and readback)
 * is written against `ControlDriver` and does not change.
 */
export function controlDriver(options: ControlOptions): ControlDriver {
    if (options.simulator !== undefined && options.simulator !== false) {
        return new SimulatorControlDriver({
            udid: typeof options.simulator === "string" ? options.simulator : undefined,
            bundleId: options.bundleId,
        });
    }
    const app = z.string().trim().min(1).parse(options.app);
    const scope = z.enum(["window", "chrome"]).parse(options.scope ?? "window");
    const windowId =
        options.windowId === undefined ? undefined : z.number().int().positive().parse(Number(options.windowId));
    return new NativeControlDriver({ app, scope, windowId, image: options.image, prepare: "auto" });
}
export function deadline(options: ControlOptions): AbortSignal {
    return AbortSignal.timeout(z.number().int().min(1).max(300000).parse(Number(options.timeout)));
}
export async function readObservation(options: ControlOptions, signal: AbortSignal) {
    if (options.snapshotFile) {
        return observationSchema.parse(SafeJSON.parse(await Bun.file(options.snapshotFile).text()));
    }
    return controlDriver(options).observe({ signal, timeoutMs: Number(options.timeout) });
}
/**
 * Run `body` with a signal that aborts on Ctrl-C, and always unhook the listener afterwards.
 *
 * Six commands had hand-rolled this identical four-line block, and `choose` had already drifted
 * by never installing a handler at all, so it alone could not be interrupted. Leaving the
 * listener attached matters too: commander runs several commands in one process during tests,
 * and an unremoved handler leaks past the command that installed it.
 */
export async function withSigintAbort<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);

    try {
        return await body(controller.signal);
    } finally {
        process.off("SIGINT", cancel);
    }
}

/**
 * One evaluator per command invocation, created on first use.
 *
 * `createEvaluator` resolves a credential, so creating one per question is real work repeated
 * for no gain. Every call site memoised the PROMISE rather than the evaluator, so two
 * overlapping questions share one resolution instead of racing two.
 */
export function lazyEvaluator(program: Command): Evaluator {
    let pending: Promise<Evaluator> | undefined;

    return async (call) => {
        pending ??= createEvaluator({ provider: selectedProvider(program) });
        return (await pending)(call);
    };
}

export function exactExpectation(options: ControlOptions) {
    if (options.exactId === undefined && options.exactValue === undefined) {
        return undefined;
    }
    if (options.exactId === undefined || options.exactValue === undefined) {
        throw new Error("--exact-id and --exact-value must be provided together.");
    }
    return { identifier: options.exactId, value: options.exactValue };
}
export function registerDecisionCommands(program: Command): void {
    addProviderOption(program);
    program.option("--no-cursor", "Disable animated visual feedback for this command");
    program.hook("preAction", () => setCursorFeedbackEnabled(program.optsWithGlobals().cursor !== false));
    observationOptions(
        program.command("resolve").description("Read-only intent resolution over observed native targets")
    )
        .requiredOption("--intent <text>", "Describe the target")
        .option("--snapshot-file <file>", "Use a retained see snapshot without inspecting the desktop")
        .action(async (options: ControlOptions & { intent: string }) => {
            const signal = deadline(options);
            const observation = await readObservation(options, signal);
            const result = await resolveIntent({
                observation,
                intent: options.intent,
                signal,
                evaluate: (call) => evaluateRequest({ ...call, provider: selectedProvider(program) }),
            });
            out.result({ ...result, snapshot: observation.snapshot, window: observation.window, pid: observation.pid });
        });
    observationOptions(program.command("judge").description("Read-only outcome verification with observed evidence"))
        .requiredOption("--expect <text>", "Describe the expected outcome")
        .option("--snapshot-file <file>", "Use a retained see snapshot")
        .option("--exact-id <id>", "Require this unique AXIdentifier's exact AXValue")
        .option("--exact-value <text>", "Exact expected AXValue; overrides semantic judgment")
        .action(async (options: ControlOptions & { expect: string }) => {
            const exact = exactExpectation(options);
            const signal = deadline(options);
            const observation = await readObservation(options, signal);
            out.result(
                await judgeOutcome({
                    observation,
                    expect: options.expect,
                    exact,
                    signal,
                    evaluate: (call) => evaluateRequest({ ...call, provider: selectedProvider(program) }),
                })
            );
        });
}
