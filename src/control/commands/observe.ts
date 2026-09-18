import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { evaluateRequest } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { observeFanout } from "../lib/decision/observe";
import { type ControlOptions, deadline, exactExpectation, observationOptions, readObservation } from "./decision";

export function registerObserveCommand(program: Command): void {
    observationOptions(program.command("observe").description("Fan-out Jev questions over one see"))
        .requiredOption("--goal <text>", "Task scoped to this app/window")
        .option("--snapshot-file <file>", "Use a retained see snapshot")
        .option("--exact-id <id>", "Exact completion identifier")
        .option("--exact-value <text>", "Exact completion value")
        .option("--yes", "Allow high-risk acts to be recommended")
        .action(
            async (
                options: ControlOptions & {
                    goal: string;
                    snapshotFile?: string;
                    yes?: boolean;
                }
            ) => {
                const signal = deadline(options);
                const observation = await readObservation(options, signal);
                out.result(
                    await observeFanout({
                        observation,
                        goal: options.goal,
                        exact: exactExpectation(options),
                        allowYes: options.yes === true,
                        signal,
                        evaluate: (call) => evaluateRequest({ ...call, provider: selectedProvider(program) }),
                    })
                );
            }
        );
}
