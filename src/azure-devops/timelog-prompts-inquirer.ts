/**
 * TimeLog Interactive Prompts - @inquirer/prompts implementation (fallback)
 */

import { convertToMinutes, formatMinutes, getTodayDate, TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";
import { ExitPromptError } from "@inquirer/core";
import { confirm, input, select } from "@inquirer/prompts";

export async function runInteractiveAddInquirer(
    config: AzureConfigWithTimeLog,
    user: TimeLogUser,
    prefilledWorkItem?: string
): Promise<void> {
    console.log("\n📝 TimeLog - Add Entry\n");

    try {
        const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog?.functionsKey, user);

        // Fetch time types
        console.log("Loading time types...");
        const types = await api.getTimeTypes();

        // Work item ID
        let workItemId: number;
        if (prefilledWorkItem) {
            workItemId = parseInt(prefilledWorkItem, 10);
            console.log(`Work Item: #${workItemId}`);
        } else {
            const workItemInput = await input({
                message: "Work Item ID:",
                validate: (value) => {
                    if (!value) {
                        return "Work item ID is required";
                    }
                    if (Number.isNaN(parseInt(value, 10))) {
                        return "Must be a number";
                    }
                    return true;
                },
            });
            workItemId = parseInt(workItemInput, 10);
        }

        // Time type
        const defaultType = types.find((t) => t.isDefaultForProject);
        const selectedType = await select({
            message: "Time Type:",
            choices: types.map((t) => ({
                value: t.description,
                name: t.description + (t.isDefaultForProject ? " (default)" : ""),
            })),
            default: defaultType?.description,
        });

        // Hours
        const hoursInput = await input({
            message: "Hours:",
            default: "1",
            validate: (value) => {
                if (!value) {
                    return "Hours is required (use 0 for minutes only)";
                }
                const num = parseFloat(value);
                if (Number.isNaN(num) || num < 0) {
                    return "Must be a non-negative number";
                }
                return true;
            },
        });
        const hours = parseFloat(hoursInput);

        // Minutes
        let minutes = 0;
        if (hours === Math.floor(hours)) {
            const minutesInput = await input({
                message: "Additional minutes:",
                default: "0",
            });
            minutes = parseInt(minutesInput || "0", 10);
        }

        const totalMinutes = convertToMinutes(hours, minutes);

        // Date
        const dateInput = await input({
            message: "Date (YYYY-MM-DD):",
            default: getTodayDate(),
            validate: (value) => {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    return "Use YYYY-MM-DD format";
                }
                return true;
            },
        });

        // Comment
        const comment = await input({
            message: "Comment (optional):",
        });

        // Confirm
        console.log(`\n${"─".repeat(40)}`);
        console.log(`Work Item: #${workItemId}`);
        console.log(`Time: ${formatMinutes(totalMinutes)}`);
        console.log(`Type: ${selectedType}`);
        console.log(`Date: ${dateInput}`);
        if (comment) {
            console.log(`Comment: ${comment}`);
        }
        console.log("─".repeat(40));

        const confirmed = await confirm({
            message: "Create this time log entry?",
            default: true,
        });

        if (!confirmed) {
            console.log("Cancelled");
            process.exit(0);
        }

        // Create entry
        console.log("\nCreating time log entry...");
        const ids = await api.createTimeLogEntry(workItemId, totalMinutes, selectedType, dateInput, comment);

        console.log(`\n✔ Time log created! Entry ID: ${ids[0]}`);
    } catch (error) {
        if (error instanceof ExitPromptError) {
            console.log("\nCancelled");
            process.exit(0);
        }
        throw error;
    }
}
