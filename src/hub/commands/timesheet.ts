import { isInteractive, suggestCommand, toolCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { fillTimesheetWeek, timesheetWeek } from "../lib/timesheet/index";

function today(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function hours(minutes: number): string {
    return (minutes / 60).toFixed(2);
}

/**
 * `tools hub timesheet`: the Clarity week the phone's Friday swipe shows (`/api/gateway/timesheet`), and
 * `tools hub timesheet fill`, its confirmed fill (`POST /api/timesheet/fill`), refused when the week changed.
 */
export function registerTimesheetCommand(program: Command): void {
    const command = program
        .command("timesheet")
        .description("The Clarity week of a date as the phone shows it: tasks, hours per day, unmapped time")
        .option("--date <yyyy-mm-dd>", "any day of the week (default: today)")
        .option("--json", "machine-readable output")
        .action(async (opts: { date?: string; json?: boolean }) => {
            const week = await timesheetWeek(opts.date ?? today());

            if (opts.json) {
                out.result(week);
                return;
            }

            if (!week) {
                out.log.warn("Clarity has no timesheet for that week.");
                return;
            }

            renderCliHeader("Timesheet", `${week.periodStart} to ${week.periodFinish} · revision ${week.revision}`);
            const table = createBoxTable(["TASK", "CODE", "HOURS", "IN CLARITY"]);

            for (const row of week.rows) {
                table.push([
                    truncateDisplay(row.task, 40),
                    row.code,
                    hours(row.totalMinutes),
                    row.clarityMinutes === null ? "" : hours(row.clarityMinutes),
                ]);
            }

            out.println(table.toString());
        });

    command
        .command("fill")
        .description("Write the week into Clarity, if it still matches the revision you saw")
        .requiredOption("--revision <hash>", `the revision ${toolCommand("hub timesheet")} printed`)
        .option("--date <yyyy-mm-dd>", "any day of the week (default: today)")
        .option("--yes", "do not ask")
        .option("--json", "machine-readable output")
        .action(async (opts: { revision: string; date?: string; yes?: boolean; json?: boolean }) => {
            const date = opts.date ?? today();
            const week = await timesheetWeek(date);

            if (!week) {
                out.log.error("Clarity has no timesheet for that week.");
                process.exitCode = 1;
                return;
            }

            if (!opts.yes) {
                if (!isInteractive()) {
                    out.log.error("Non-interactive: pass --yes to write real hours.");
                    out.log.info(
                        suggestCommand("tools hub", {
                            replaceCommand: ["timesheet", "fill", "--revision", opts.revision],
                            add: ["--yes"],
                        })
                    );
                    process.exitCode = 2;
                    return;
                }

                const ok = await p.confirm({
                    message: `Write ${hours(week.totalMinutes)} h into Clarity?`,
                    initialValue: false,
                });

                if (p.isCancel(ok) || !ok) {
                    out.log.info("Cancelled. Nothing was written.");
                    process.exitCode = 1;
                    return;
                }
            }

            const receipt = await fillTimesheetWeek({ date, timesheetId: week.timesheetId, revision: opts.revision });
            process.exitCode = receipt.filled ? 0 : 1;

            if (opts.json) {
                out.result(receipt);
                return;
            }

            out.log.info(
                receipt.error ?? `Written ${receipt.written}, failed ${receipt.failed}, skipped ${receipt.skipped}.`
            );
        });
}
