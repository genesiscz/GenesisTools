import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { awaitCondition } from "../lib/decision/await";
import { NativeObservationSource } from "../lib/decision/observation-source";
import { replayWait, waitCases } from "../lib/decision/wait-replay";
import { type ControlOptions, controlDriver, observationOptions } from "./decision";

export function registerAwaitCommand(program: Command) {
    const command = observationOptions(
        program
            .command("await")
            .description("Wait for semantic readiness; unchanged observations cost no extra Jev requests")
    );
    command.options.find((option) => option.long === "--timeout")?.default("30000");
    command.setOptionValueWithSource("timeout", "30000", "default");
    command
        .requiredOption("--condition <text>", "Observed completion condition")
        .option("--max-requests <n>", "Maximum evaluations on meaningful changes", "12")
        .action(async (options: ControlOptions & { condition: string; maxRequests: string }) => {
            const controller = new AbortController();
            const cancel = () => controller.abort();
            process.once("SIGINT", cancel);
            let evaluate: Promise<Evaluator> | undefined;
            try {
                const driver = controlDriver({ ...options, image: false });
                const result = await awaitCondition({
                    condition: options.condition,
                    driver,
                    source: new NativeObservationSource(driver),
                    signal: controller.signal,
                    limits: { timeoutMs: Number(options.timeout), maxRequests: Number(options.maxRequests) },
                    evaluate: async (call) => {
                        evaluate ??= createEvaluator({ provider: selectedProvider(program) });
                        return (await evaluate)(call);
                    },
                });
                out.result(result);
                if (result.status !== "ready") {
                    process.exitCode = 1;
                }
            } finally {
                process.off("SIGINT", cancel);
            }
        });
    program
        .command("wait-replay [case]")
        .description("Replay semantic waits on a virtual clock without desktop actions")
        .option("--chooser [mode]", "oracle or jev", "oracle")
        .option("--list", "List wait scenarios without calling a model")
        .action(async (name: string | undefined, options: { chooser: string | boolean; list?: boolean }) => {
            if (options.list) {
                out.result(waitCases.map(({ id, title }) => ({ id, title })));
                return;
            }
            out.result(
                await replayWait({
                    input: { id: name ?? "ready", chooser: options.chooser },
                    provider: selectedProvider(program),
                    signal: AbortSignal.timeout(30000),
                })
            );
        });
}
