import { Api } from "@app/azure-devops/api";
import { deleteTimeLogEntryWithEffort, printDeleteResult } from "@app/azure-devops/lib/timelog/delete-entry";
import { formatMinutes, TimeLogApi } from "@app/azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerDeleteSubcommand(parent: Command): void {
    parent
        .command("delete")
        .description("Delete a time log entry and roll back Remaining/Completed Work")
        .argument("[timeLogId]", "Time log entry ID (or use --workitem for interactive)")
        .option("-w, --workitem <id>", "Work item ID (interactive picker, or a hint for a bare id)")
        .option("--no-effort", "Delete the row only; leave Remaining/Completed untouched")
        .option("--dry-run", "Print the planned effort transition; change nothing")
        .option("--yes", "Skip the confirm prompt (required without a TTY)")
        .action(
            async (
                timeLogIdArg: string | undefined,
                options: { workitem?: string; effort?: boolean; dryRun?: boolean; yes?: boolean }
            ) => {
                const noEffort = options.effort === false;
                const config = requireTimeLogConfig();
                const user = requireTimeLogUser(config);
                const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

                let timeLogId = timeLogIdArg;
                let workItemId: number | undefined;
                let knownMinutes: number | undefined;

                if (options.workitem) {
                    const parsed = parseInt(options.workitem, 10);

                    if (Number.isNaN(parsed)) {
                        out.error("Invalid work item ID");
                        process.exit(1);
                    }

                    workItemId = parsed;
                }

                if (!timeLogId) {
                    if (workItemId == null) {
                        out.error("Provide a timeLogId or --workitem for interactive selection");
                        out.error("\nExamples:");
                        out.error("  tools azure-devops timelog delete <timeLogId> --yes");
                        out.error("  tools azure-devops timelog delete --workitem 268935");
                        out.error("  tools azure-devops timelog delete <timeLogId> --dry-run");
                        process.exit(1);
                    }

                    const entries = await api.getWorkItemTimeLogs(workItemId);

                    if (entries.length === 0) {
                        out.println(`No time logs found for #${workItemId}`);
                        return;
                    }

                    if (!isInteractive()) {
                        out.error("Interactive picker needs a TTY. Pass the timeLogId and --yes.");
                        out.info(
                            suggestCommand("tools azure-devops timelog delete", {
                                add: ["--yes"],
                                subcommand: ["timelog", "delete"],
                            })
                        );
                        process.exit(1);
                    }

                    const selected = await p.select({
                        message: `Select entry to delete from #${workItemId}:`,
                        options: entries.map((e) => ({
                            value: e.timeLogId,
                            label: `${e.date} | ${formatMinutes(e.minutes)} | ${e.timeTypeDescription} | ${e.userName}${e.comment ? ` | ${e.comment}` : ""}`,
                        })),
                    });

                    if (p.isCancel(selected)) {
                        p.cancel("Cancelled");
                        return;
                    }

                    timeLogId = selected as string;
                    const picked = entries.find((e) => e.timeLogId === timeLogId);
                    knownMinutes = picked?.minutes;
                }

                if (!timeLogId) {
                    out.error("Provide a timeLogId or --workitem for interactive selection");
                    process.exit(1);
                }

                if (!options.yes && !options.dryRun && !isInteractive()) {
                    out.error("Confirm required in non-interactive mode. Re-run with --yes.");
                    out.info(
                        suggestCommand("tools azure-devops timelog delete", {
                            add: ["--yes"],
                            subcommand: ["timelog", "delete"],
                        })
                    );
                    process.exit(1);
                }

                const result = await deleteTimeLogEntryWithEffort({
                    timeLogApi: api,
                    devopsApi: new Api(config),
                    timeLogId,
                    user,
                    projectId: config.projectId,
                    workItemId,
                    knownMinutes,
                    noEffort,
                    dryRun: options.dryRun,
                    confirm:
                        options.yes || options.dryRun
                            ? undefined
                            : async () => {
                                  const ok = await p.confirm({
                                      message: `Delete time log entry ${timeLogId.substring(0, 8)}...?`,
                                  });
                                  return !p.isCancel(ok) && !!ok;
                              },
                });

                if (result.status === "cancelled") {
                    p.cancel("Cancelled");
                    return;
                }

                printDeleteResult(result, { noEffort });
            }
        );
}
