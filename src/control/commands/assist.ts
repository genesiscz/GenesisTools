import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { assistTask } from "../lib/decision/assist";
import { chooserModeSchema, readHostDecision } from "../lib/decision/chooser";
import { remedySchema } from "../lib/decision/recovery";
import {
    type ControlOptions,
    controlDriver,
    exactExpectation,
    lazyEvaluator,
    observationOptions,
    withSigintAbort,
} from "./decision";

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
        .option("--recovery [mode]", "Recovery: off or bounded", "off")
        .option("--chooser [mode]", "Target chooser: exact, jev or auto (Jev only; host handoff on uncertainty)", "jev")
        .option("--no-fanout", "Restore the serial chooser instead of observe fan-out")
        .option(
            "--host-decision <json>",
            "Explicit host answer plus original packet; revalidated against current state"
        )
        .option("--max-recoveries <n>", "Separate recovery attempt cap", "2")
        .option("--remedies <json>", "File with explicitly authorized dismiss/back targets")
        .option(
            "--check-first",
            "Judge the postcondition BEFORE the first action, for an idempotent goal that may already be satisfied. Off by default: an unmet goal at t0 is the normal starting state, not a failure, and skipping this check saves one paid evaluation."
        )
        .option("--exact-id <id>", "Use a unique AXIdentifier for completion readback")
        .option("--exact-value <text>", "Exact completion value")
        .action(
            async (
                options: ControlOptions & {
                    goal: string;
                    expect?: string;
                    maxSteps: string;
                    maxRequests: string;
                    recovery: string;
                    maxRecoveries: string;
                    remedies?: string;
                    chooser: string | boolean;
                    hostDecision?: string;
                    fanout?: boolean;
                    checkFirst?: boolean;
                }
            ) => {
                const parsedMode = z.enum(["off", "bounded"]).safeParse(options.recovery);
                if (!parsedMode.success) {
                    out.log.error(suggestEnumFlag("tools control assist", "--recovery", ["off", "bounded"]));
                    process.exitCode = 1;
                    return;
                }
                const mode = parsedMode.data;
                const chooser = chooserModeSchema.safeParse(options.chooser);
                if (!chooser.success) {
                    out.log.error(suggestEnumFlag("tools control assist", "--chooser", ["exact", "jev", "auto"]));
                    process.exitCode = 1;
                    return;
                }
                const hostDecision = options.hostDecision
                    ? readHostDecision(SafeJSON.parse(await Bun.file(options.hostDecision).text()))
                    : undefined;
                const remedies = options.remedies
                    ? z.array(remedySchema).parse(SafeJSON.parse(await Bun.file(options.remedies).text()))
                    : [];
                await withSigintAbort(async (signal) => {
                    const result = await assistTask({
                        goal: options.goal,
                        chooser: chooser.data,
                        checkFirst: options.checkFirst === true,
                        fanout: options.fanout !== false,
                        hostDecision,
                        recovery: { mode, remedies, maxRecoveries: Number(options.maxRecoveries) },
                        expect: options.expect,
                        exact: exactExpectation(options),
                        driver: controlDriver(options),
                        signal,
                        limits: {
                            timeoutMs: Number(options.timeout),
                            maxActions: Number(options.maxSteps),
                            maxRequests: Number(options.maxRequests),
                        },
                        evaluate: lazyEvaluator(program),
                    });
                    out.result(result);
                    if (result.status !== "verified") {
                        process.exitCode = 1;
                    }
                });
            }
        );
}
