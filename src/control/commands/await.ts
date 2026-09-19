import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { awaitCondition } from "../lib/decision/await";
import { evidenceScopeSchema } from "../lib/decision/observation";
import { NativeObservationSource } from "../lib/decision/observation-source";
import { replayWait, waitCases } from "../lib/decision/wait-replay";
import {
    type ControlOptions,
    controlDriver,
    exactExpectation,
    lazyEvaluator,
    observationOptions,
    withSigintAbort,
} from "./decision";

export function registerAwaitCommand(program: Command) {
    const command = observationOptions(
        program
            .command("await")
            .description("Wait for exact local readback or Jev readiness; unchanged observations skip evaluation")
    );
    command.options.find((option) => option.long === "--timeout")?.default("30000");
    command.setOptionValueWithSource("timeout", "30000", "default");
    command
        .requiredOption("--condition <text>", "Observed completion condition")
        .option("--exact-id <id>", "Check this unique AXIdentifier locally, without Jev")
        .option("--exact-value <text>", "Exact expected AXValue; requires --exact-id")
        .option("--evidence-id <id>", "Observe readiness only within this exact container identifier")
        .option("--evidence-label <text>", "Observe readiness only within this exact container label")
        .option("--evidence-role <role>", "Disambiguate the evidence container by AX role")
        .option("--max-requests <n>", "Maximum evaluations on meaningful changes", "12")
        .action(
            async (
                options: ControlOptions & {
                    condition: string;
                    maxRequests: string;
                    evidenceId?: string;
                    evidenceLabel?: string;
                    evidenceRole?: string;
                }
            ) => {
                await withSigintAbort(async (signal) => {
                    const exact = exactExpectation(options);
                    const driver = controlDriver({ ...options, image: false });
                    const result = await awaitCondition({
                        condition: options.condition,
                        exact,
                        evidenceScope:
                            options.evidenceId || options.evidenceLabel || options.evidenceRole
                                ? evidenceScopeSchema.parse({
                                      identifier: options.evidenceId,
                                      label: options.evidenceLabel,
                                      role: options.evidenceRole,
                                  })
                                : undefined,
                        driver,
                        source: new NativeObservationSource({ driver }),
                        signal,
                        limits: { timeoutMs: Number(options.timeout), maxRequests: Number(options.maxRequests) },
                        evaluate: lazyEvaluator(program),
                    });
                    out.result(result);

                    if (result.status !== "ready") {
                        process.exitCode = 1;
                    }
                });
            }
        );
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
