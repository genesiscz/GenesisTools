import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { NativeFolderDriver, navigateFolders } from "../lib/decision/folders";

export function registerFolderCommands(program: Command) {
    const folders = program
        .command("folders")
        .description("Fast native folder sequences: one inventory, optional batched Jev resolution, focused readback");
    const driver = (options: { app: string; windowId?: string }) =>
        new NativeFolderDriver({
            app: z.string().min(1).parse(options.app),
            windowId:
                options.windowId === undefined
                    ? undefined
                    : z.number().int().positive().parse(Number(options.windowId)),
        });
    folders
        .command("list")
        .description("Read visible expandable folders in one unique outline; no screenshots or model calls")
        .requiredOption("--app <name>", "App name or PID")
        .option("--window-id <id>", "Pin a window when more than one outline exists")
        .action(async (options) =>
            out.result(await driver(options).inspect({ signal: AbortSignal.timeout(10000), timeoutMs: 10000 }))
        );
    for (const mode of ["open", "close", "toggle", "peek"] as const) {
        folders
            .command(`${mode} <names...>`)
            .description(
                mode === "peek"
                    ? "Toggle each folder then restore its original state"
                    : `${mode} folders with exact expanded-state readback`
            )
            .requiredOption("--app <name>", "App name or PID")
            .option("--window-id <id>", "Pin the window")
            .option("--semantic", "Treat every name as an intent; resolve all targets in one Jev request")
            .option("--interval <ms>", "Spacing between action starts (0–5000)", "1000")
            .option("--timeout <ms>", "Total deadline", "120000")
            .action(async (names: string[], options) => {
                const controller = new AbortController();
                const cancel = () => controller.abort();
                process.once("SIGINT", cancel);
                let evaluator: Promise<Evaluator> | undefined;
                try {
                    const result = await navigateFolders({
                        names,
                        mode,
                        semantic: options.semantic,
                        intervalMs: Number(options.interval),
                        limits: { timeoutMs: Number(options.timeout) },
                        signal: controller.signal,
                        driver: driver(options),
                        evaluate: async (call) => {
                            evaluator ??= createEvaluator({ provider: selectedProvider(program) });
                            return (await evaluator)(call);
                        },
                    });
                    out.result(result);
                    if (result.status !== "verified") {
                        process.exitCode = 1;
                    }
                } finally {
                    process.off("SIGINT", cancel);
                }
            });
    }
}
