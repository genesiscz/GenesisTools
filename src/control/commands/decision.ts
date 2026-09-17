import { addProviderOption, selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { evaluateRequest } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { judgeOutcome, resolveIntent } from "../lib/decision/decisions";
import { NativeControlDriver } from "../lib/decision/native";
import { observationSchema } from "../lib/decision/observation";

export interface ControlOptions {
    app?: string;
    windowId?: string;
    scope?: string | boolean;
    snapshotFile?: string;
    timeout: string;
    exactId?: string;
    exactValue?: string;
}
export function observationOptions(command: Command): Command {
    return command
        .option("--app <name>", "Target app name or PID")
        .option("--window-id <id>", "Pin to a native window ID")
        .option("--scope [scope]", "AX scope: window or chrome", "window")
        .option("--timeout <ms>", "Total deadline in milliseconds", "120000");
}
export function controlDriver(options: ControlOptions) {
    const app = z.string().trim().min(1).parse(options.app);
    const scope = z.enum(["window", "chrome"]).parse(options.scope ?? "window");
    const windowId =
        options.windowId === undefined ? undefined : z.number().int().positive().parse(Number(options.windowId));
    return new NativeControlDriver({ app, scope, windowId });
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
