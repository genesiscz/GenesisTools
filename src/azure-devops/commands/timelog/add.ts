import { Api } from "@app/azure-devops/api";
import { AzureDevOpsCacheManager } from "@app/azure-devops/cache-manager";
import { convertToMinutes, formatMinutes, getTodayDate, TimeLogApi } from "@app/azure-devops/timelog-api";
import { updateWorkItemEffort } from "@app/azure-devops/timelog-effort";
import { runInteractiveAddClack } from "@app/azure-devops/timelog-prompts-clack";
import { runInteractiveAddInquirer } from "@app/azure-devops/timelog-prompts-inquirer";
import type { AllowedTypeConfig, AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { precheckWorkItem } from "@app/azure-devops/workitem-precheck";
import logger from "@app/logger";
import type { Command } from "commander";
import pc from "picocolors";

// Toggle between prompt implementations
// 1 = @clack/prompts (preferred)
// 0 = @inquirer/prompts (fallback)
const USE_CLACK = 1;

async function runInteractiveAdd(
    config: AzureConfigWithTimeLog,
    user: TimeLogUser,
    prefilledWorkItem?: string,
): Promise<void> {
    if (USE_CLACK) {
        await runInteractiveAddClack(config, user, prefilledWorkItem);
    } else {
        await runInteractiveAddInquirer(config, user, prefilledWorkItem);
    }
}

function showAddHelp(): void {
    console.log(`
Usage: tools azure-devops timelog add [options]

Required (unless -i):
  -w, --workitem <id>     Work item ID to log time against
  -h, --hours <number>    Hours to log (e.g., 2)
  -t, --type <name>       Time type (see 'timelog types' for list)

Optional:
  -m, --minutes <number>  Additional minutes (requires --hours to be set)
  -d, --date <YYYY-MM-DD> Date of the entry (default: today)
  -c, --comment <text>    Description of work performed
  -i, --interactive       Interactive mode with prompts

Note: If using only minutes, specify --hours 0 --minutes <n> to confirm intent.

Examples:
  tools azure-devops timelog add -w 268935 -h 2 -t "Development"
  tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"
  tools azure-devops timelog add -w 268935 -h 0 -m 30 -t "Test" -d 2026-02-03
  tools azure-devops timelog add -i
  tools azure-devops timelog add -w 268935 -i
`);
}

export function registerAddSubcommand(parent: Command): void {
    parent
        .command("add")
        .description("Add a time log entry")
        .option("-w, --workitem <id>", "Work item ID")
        .option("-h, --hours <hours>", "Hours to log")
        .option("-m, --minutes <minutes>", "Additional minutes (requires --hours)")
        .option("-t, --type <type>", 'Time type (e.g., "Development")')
        .option("-d, --date <date>", "Date (YYYY-MM-DD, default: today)")
        .option("-c, --comment <text>", "Comment/description")
        .option("-i, --interactive", "Interactive mode with prompts")
        .option("-?, --help-full", "Show detailed help")
        .action(
            async (options: {
                workitem?: string;
                hours?: string;
                minutes?: string;
                type?: string;
                date?: string;
                comment?: string;
                interactive?: boolean;
                helpFull?: boolean;
            }) => {
                if (options.helpFull) {
                    showAddHelp();
                    return;
                }

                const config = requireTimeLogConfig();
                const user = requireTimeLogUser(config);

                // Interactive mode
                if (options.interactive) {
                    await runInteractiveAdd(config, user, options.workitem);
                    return;
                }

                // Validate required fields
                if (!options.workitem || !options.hours || !options.type) {
                    console.error(`
Missing required options for non-interactive mode.

Required: --workitem, --hours, --type

Examples:
  tools azure-devops timelog add -w 268935 -h 2 -t "Development"
  tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"

Or use interactive mode:
  tools azure-devops timelog add -i
  tools azure-devops timelog add -w 268935 -i
`);
                    process.exit(1);
                }

                const workItemId = parseInt(options.workitem, 10);

                if (Number.isNaN(workItemId)) {
                    console.error("Invalid work item ID");
                    process.exit(1);
                }

                // Convert hours/minutes
                let totalMinutes: number;

                try {
                    totalMinutes = convertToMinutes(
                        options.hours ? parseFloat(options.hours) : undefined,
                        options.minutes ? parseInt(options.minutes, 10) : undefined,
                    );
                } catch (e) {
                    console.error(`${(e as Error).message}`);
                    process.exit(1);
                }

                const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog?.functionsKey, user);

                // Validate time type exists
                const validType = await api.validateTimeType(options.type);

                if (!validType) {
                    const types = await api.getTimeTypes();
                    console.error(`
Unknown time type: "${options.type}"

Available types:
${types.map((t) => `  - ${t.description}`).join("\n")}
`);
                    process.exit(1);
                }

                const date = options.date || getTodayDate();
                const comment = options.comment || "";

                // Precheck work item type
                let effectiveWorkItemId = workItemId;

                const allowedTypeConfig: AllowedTypeConfig | undefined = config.timelog?.allowedWorkItemTypes?.length
                    ? {
                          allowedWorkItemTypes: config.timelog?.allowedWorkItemTypes,
                          allowedStatesPerType: config.timelog?.allowedStatesPerType,
                          deprioritizedStates: config.timelog?.deprioritizedStates,
                          defaultUserName: config.timelog?.defaultUser?.userName,
                      }
                    : undefined;

                if (!allowedTypeConfig) {
                    logger.debug("[add] allowedWorkItemTypes not configured, skipping precheck");
                } else {
                    const result = await precheckWorkItem(workItemId, config.org, allowedTypeConfig);

                    if (result.status === "redirect") {
                        console.log(pc.yellow(`\u26A0 ${result.message}`));
                        effectiveWorkItemId = result.redirectId!;
                    } else if (result.status === "error") {
                        console.error(pc.red(`\u2716 ${result.message}`));

                        if (result.suggestCommands?.length) {
                            console.log("\nSuggested commands:");

                            for (const cmd of result.suggestCommands) {
                                console.log(`  ${cmd}`);
                            }
                        }

                        process.exit(1);
                    }
                }

                // Create the entry
                const ids = await api.createTimeLogEntry(
                    effectiveWorkItemId,
                    totalMinutes,
                    validType.description, // Use exact casing from API
                    date,
                    comment,
                );

                console.log(`\u2714 Time logged successfully!`);
                console.log(`  Work Item: #${effectiveWorkItemId}`);
                console.log(`  Time: ${formatMinutes(totalMinutes)}`);
                console.log(`  Type: ${validType.description}`);
                console.log(`  Date: ${date}`);

                if (comment) {
                    console.log(`  Comment: ${comment}`);
                }

                console.log(`  Entry ID: ${ids[0]}`);

                // Update Remaining/Completed Work on the work item
                const devopsApi = new Api(config);
                const effort = await updateWorkItemEffort(devopsApi, effectiveWorkItemId, totalMinutes);

                if (effort) {
                    console.log(`  Remaining: ${effort.remaining}h | Completed: ${effort.completed}h`);
                }

                // Evict timelog cache for affected work item
                const cacheManager = new AzureDevOpsCacheManager();
                cacheManager.onTimelogCreated([effectiveWorkItemId]).catch((err) => {
                    logger.debug(`[add] Cache eviction failed: ${err}`);
                });
            },
        );
}
