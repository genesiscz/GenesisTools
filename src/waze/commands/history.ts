import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { ALERT_CATEGORIES, isAlertCategory } from "../lib/types";
import { parseIntArg, parseNumberArg, runOperation, TOOL } from "./run";

export function registerHistoryCommands(program: Command): void {
    program
        .command("record [area]")
        .description(
            "Save a snapshot of the reports in an area (or along a trip with --from/--to) to the local history"
        )
        .option("--from <place>", "Trip start (with --to)")
        .option("--to <place>", "Trip destination (with --from)")
        .option("--radius <km>", "Radius around a place (default 10)", parseNumberArg)
        .option("--corridor <metres>", "Trip corridor width (default 150)", parseIntArg)
        .action(
            async (
                area: string | undefined,
                flags: { from?: string; to?: string; radius?: number; corridor?: number },
                command: Command
            ) => {
                if (!area && !(flags.from && flags.to)) {
                    out.log.error("Give an area, or both --from and --to");
                    process.exitCode = 1;
                    return;
                }

                await runOperation(command, "record", {
                    area,
                    from: flags.from,
                    to: flags.to,
                    radiusKm: flags.radius,
                    corridorM: flags.corridor,
                });
            }
        );

    program
        .command("history")
        .description("Recorded snapshots, newest first")
        .option("--limit <n>", "Most snapshots (default 20)", parseIntArg)
        .action(async (flags: { limit?: number }, command: Command) => {
            await runOperation(command, "history", { limit: flags.limit });
        });

    program
        .command("hotspots")
        .description("Places with the most recorded reports of a category, and the hours they cluster in")
        .option("--category [category]", `Report category: ${ALERT_CATEGORIES.join(", ")} (default police)`)
        .option("--since <days>", "Only reports from the last N days", parseNumberArg)
        .option("--cell <km>", "Grid cell size in km (default 1)", parseNumberArg)
        .option("--limit <n>", "Most places (default 15)", parseIntArg)
        .action(
            async (
                flags: { category?: string | boolean; since?: number; cell?: number; limit?: number },
                command: Command
            ) => {
                const category = await pickEnumFlag({
                    tool: `${TOOL} hotspots`,
                    subcommand: ["hotspots"],
                    flag: "--category",
                    given: flags.category,
                    values: ALERT_CATEGORIES,
                    fallback: "police",
                    accepts: isAlertCategory,
                });
                if (!category) {
                    return;
                }

                await runOperation(command, "hotspots", {
                    category,
                    sinceDays: flags.since,
                    cellKm: flags.cell,
                    limit: flags.limit,
                });
            }
        );
}
