import { writeFile } from "node:fs/promises";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { NativeControlDriver } from "../lib/decision/native";
import { applyWorkflowRepairs, parseWorkflowPlan, replayWorkflow } from "../lib/decision/workflow";

export function registerReplayPlanCommand(program: Command) {
    program
        .command("replay-plan <file>")
        .description("Replay a versioned semantic plan against fresh native observations")
        .option("--values <json>", "Local exact string values keyed by reference; never sent to the chooser")
        .option("--rebind", "Allow Jev to repair a missing selector within the recorded action/scope", false)
        .option("--jev", "Explicitly enable Jev semantic postconditions", false)
        .option("--window-id <id>", "Pin the run to this native window")
        .option("--save-repairs <new-file>", "After a verified run, save a new plan with repaired selectors")
        .option("--timeout <ms>", "Shared total deadline", "120000")
        .option("--max-steps <n>", "Shared action cap", "20")
        .option("--max-requests <n>", "Shared paid request cap", "30")
        .action(
            async (
                file: string,
                options: {
                    values?: string;
                    rebind: boolean;
                    jev: boolean;
                    windowId?: string;
                    saveRepairs?: string;
                    timeout: string;
                    maxSteps: string;
                    maxRequests: string;
                }
            ) => {
                const input = Bun.file(file);
                if (input.size > 262144) {
                    throw new Error("Workflow files must be at most 256 KB.");
                }
                const plan = parseWorkflowPlan(SafeJSON.parse(await input.text()));
                const valuesFile = options.values ? Bun.file(options.values) : undefined;
                if (valuesFile && valuesFile.size > 262144) {
                    throw new Error("Values files must be at most 256 KB.");
                }
                const values = valuesFile
                    ? z.record(z.string(), z.string()).parse(SafeJSON.parse(await valuesFile.text()))
                    : {};
                const windowId =
                    options.windowId === undefined
                        ? undefined
                        : z.number().int().positive().parse(Number(options.windowId));
                const controller = new AbortController();
                const cancel = () => controller.abort();
                process.once("SIGINT", cancel);
                let evaluator: Promise<Evaluator> | undefined;
                try {
                    const result = await replayWorkflow({
                        plan,
                        values,
                        rebind: options.rebind,
                        jev: options.jev,
                        signal: controller.signal,
                        driver: new NativeControlDriver({
                            app: plan.app,
                            scope: plan.scope,
                            windowId,
                            image: false,
                            prepare: "auto",
                        }),
                        limits: {
                            timeoutMs: Number(options.timeout),
                            maxActions: Number(options.maxSteps),
                            maxRequests: Number(options.maxRequests),
                        },
                        evaluate: async (call) => {
                            evaluator ??= createEvaluator({ provider: selectedProvider(program) });
                            return (await evaluator)(call);
                        },
                    });
                    if (options.saveRepairs && result.status === "verified") {
                        const repaired = applyWorkflowRepairs({ plan, repairs: result.repairs });
                        await writeFile(options.saveRepairs, `${SafeJSON.stringify(repaired, null, 2)}\n`, {
                            flag: "wx",
                            mode: 0o600,
                        });
                    }
                    out.result(result);
                    if (result.status !== "verified") {
                        process.exitCode = 1;
                    }
                } finally {
                    process.off("SIGINT", cancel);
                }
            }
        );
}
