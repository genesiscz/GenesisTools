import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { chooseCandidate, chooserModeSchema, readHostDecision } from "../lib/decision/chooser";
import { compareChoosers } from "../lib/decision/chooser-replay";
import { ControlSession } from "../lib/decision/session";
import { type ControlOptions, lazyEvaluator, observationOptions, readObservation } from "./decision";

export function registerChooseCommand(program: Command) {
    observationOptions(
        program.command("choose").description("Read-only exact/Jev choice; uncertainty returns an evidence packet")
    )
        .requiredOption("--intent <text>", "Target intent or exact label")
        .option("--chooser [mode]", "exact, jev or auto; Jev is the only AI model", "exact")
        .option("--snapshot-file <json>", "Retained observation; no desktop interaction")
        .option("--host-decision <json>", "Explicit host packet and answer, checked against this observation")
        .action(
            async (options: ControlOptions & { intent: string; chooser: string | boolean; hostDecision?: string }) => {
                const mode = chooserModeSchema.safeParse(options.chooser);
                if (!mode.success) {
                    out.log.error(suggestEnumFlag("tools control choose", "--chooser", ["exact", "jev", "auto"]));
                    process.exitCode = 1;
                    return;
                }
                const hostDecision = options.hostDecision
                    ? readHostDecision(SafeJSON.parse(await Bun.file(options.hostDecision).text()))
                    : undefined;
                const session = new ControlSession({
                    driver: {
                        observe: (call) =>
                            readObservation(options, call.signal ?? AbortSignal.timeout(Number(options.timeout))),
                        act: async () => {
                            throw new Error("choose is read-only");
                        },
                    },
                    limits: { timeoutMs: Number(options.timeout), maxRequests: 1, maxActions: 0 },
                    evaluate: lazyEvaluator(program),
                });
                const result = await chooseCandidate({
                    observation: await session.observe(),
                    intent: options.intent,
                    mode: mode.data,
                    session,
                    hostDecision,
                });
                out.result({ ...result, metrics: session.report() });
            }
        );
    program
        .command("compare-choosers")
        .description("Compare exact, Jev and auto on the same synthetic corpus; never dispatches")
        .option("--jev", "Explicitly allow Jev requests; otherwise exact-only", false)
        .option("--split [split]", "development, held-out or all", "held-out")
        .option("--calibrate", "Replay conservative thresholds; requires --jev --split all", false)
        .action(async (options: { jev: boolean; split: string | boolean; calibrate: boolean }) => {
            out.result(
                await compareChoosers({
                    input: { jev: options.jev, split: options.split, calibrate: options.calibrate },
                    provider: selectedProvider(program),
                    signal: AbortSignal.timeout(120000),
                })
            );
        });
}
