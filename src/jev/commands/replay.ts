import { ui } from "@genesiscz/utils/cli/ui";
import type { Command } from "commander";
import { failPlain, printResult } from "../lib/cli-output";
import { replayRun } from "../lib/loop/record";

export function registerReplay(program: Command): void {
    program
        .command("replay <runDir>")
        .description(
            "Rebuild a recorded goal run's decisions offline with today's code and the saved answers (no Jev call)"
        )
        .option("--step <n>", "Replay one step only")
        .option("--json", "Print the per-step result as JSON")
        .action(async (runDir: string, options: { step?: string; json?: boolean }) => {
            try {
                const steps = await replayRun(runDir, {
                    step: options.step === undefined ? undefined : Number(options.step),
                });
                if (steps.length === 0) {
                    ui.err(`No step files in ${runDir}.`);
                    process.exitCode = 1;
                    return;
                }

                for (const step of steps) {
                    const same = step.requestsMatch && step.decisionMatch;
                    const line = `step ${step.step} ${same ? "same" : "CHANGED"}  requests ${step.requestsMatch ? "same" : "differ"}  decision ${step.saved}${step.decisionMatch ? "" : ` -> ${step.replayed}`}`;
                    if (same) {
                        ui.ok(line);
                    } else {
                        ui.warn(line);
                    }
                }

                if (options.json) {
                    printResult(steps);
                }

                if (steps.some((step) => !step.requestsMatch || !step.decisionMatch)) {
                    process.exitCode = 1;
                }
            } catch (error) {
                failPlain(error, { command: "jev replay" });
            }
        });
}
