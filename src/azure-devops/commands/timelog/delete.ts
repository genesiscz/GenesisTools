import { Command } from "commander";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { TimeLogApi, formatMinutes } from "@app/azure-devops/timelog-api";
import * as p from "@clack/prompts";

export function registerDeleteSubcommand(parent: Command): void {
    parent
        .command("delete")
        .description("Delete a time log entry")
        .argument("[timeLogId]", "Time log entry ID (or use --workitem for interactive)")
        .option("-w, --workitem <id>", "Work item ID (interactive picker)")
        .action(
            async (timeLogIdArg: string | undefined, options: { workitem?: string }) => {
                const config = requireTimeLogConfig();
                const user = requireTimeLogUser(config);
                const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

                let timeLogId = timeLogIdArg;

                if (!timeLogId) {
                    // Interactive mode: pick from work item's entries
                    if (!options.workitem) {
                        console.error("Provide a timeLogId or --workitem for interactive selection");
                        console.error("\nExamples:");
                        console.error("  tools azure-devops timelog delete <timeLogId>");
                        console.error("  tools azure-devops timelog delete --workitem 268935");
                        process.exit(1);
                    }

                    const workItemId = parseInt(options.workitem, 10);

                    if (isNaN(workItemId)) {
                        console.error("Invalid work item ID");
                        process.exit(1);
                    }

                    const entries = await api.getWorkItemTimeLogs(workItemId);

                    if (entries.length === 0) {
                        console.log(`No time logs found for #${workItemId}`);
                        return;
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
                }

                // Confirm deletion
                const confirm = await p.confirm({
                    message: `Delete time log entry ${timeLogId.substring(0, 8)}...?`,
                });

                if (p.isCancel(confirm) || !confirm) {
                    p.cancel("Cancelled");
                    return;
                }

                await api.deleteTimeLogEntry(timeLogId);
                console.log(`\u2714 Deleted time log entry ${timeLogId.substring(0, 8)}...`);
            }
        );
}
