import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { assistTask } from "../lib/decision/assist";
import { type ControlOptions, controlDriver, exactExpectation, observationOptions } from "./decision";

export function registerAssistCommand(program: Command) {
    observationOptions(
        program
            .command("assist")
            .description("Run bounded observed AXPress actions until the postcondition is verified")
    )
        .requiredOption("--goal <text>", "Task scoped to this app/window")
        .option("--expect <text>", "Completion condition (defaults to goal)")
        .option("--max-steps <n>", "Maximum action attempts", "8")
        .option("--max-requests <n>", "Maximum paid evaluations", "20")
        .option("--exact-id <id>", "Use a unique AXIdentifier for completion readback")
        .option("--exact-value <text>", "Exact completion value")
        .action(
            async (
                options: ControlOptions & { goal: string; expect?: string; maxSteps: string; maxRequests: string }
            ) => {
                const controller = new AbortController();
                const cancel = () => controller.abort();
                process.once("SIGINT", cancel);
                let evaluator: Promise<Evaluator> | undefined;
                try {
                    const result = await assistTask({
                        goal: options.goal,
                        expect: options.expect,
                        exact: exactExpectation(options),
                        driver: controlDriver(options),
                        signal: controller.signal,
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
