/**
 * TimeLog Interactive Prompts - @inquirer/prompts implementation (fallback)
 */

import { convertToMinutes, formatMinutes, getTodayDate, TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";
import { out } from "@app/logger";
import * as p from "@app/utils/prompts/p";

export async function runInteractiveAddInquirer(
    config: AzureConfigWithTimeLog,
    user: TimeLogUser,
    prefilledWorkItem?: string
): Promise<void> {
    out.print("\n📝 TimeLog - Add Entry\n");

    try {
        const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

        // Fetch time types
        out.print("Loading time types...");
        const types = await api.getTimeTypes();

        // Work item ID
        let workItemId: number;
        if (prefilledWorkItem) {
            workItemId = parseInt(prefilledWorkItem, 10);
            out.print(`Work Item: #${workItemId}`);
        } else {
            const workItemInput = await p.text({
                message: "Work Item ID:",
                validate: (value) => {
                    if (!value) {
                        return "Work item ID is required";
                    }
                    if (Number.isNaN(parseInt(value, 10))) {
                        return "Must be a number";
                    }
                    return undefined;
                },
            });
            workItemId = parseInt(workItemInput, 10);
        }

        // Time type
        const defaultType = types.find((t) => t.isDefaultForProject);
        const selectedType = (await p.select({
            message: "Time Type:",
            options: types.map((t) => ({
                value: t.description,
                label: t.description + (t.isDefaultForProject ? " (default)" : ""),
            })),
            initialValue: defaultType?.description,
        })) as string;

        // Hours
        const hoursInput = await p.text({
            message: "Hours:",
            initialValue: "1",
            validate: (value) => {
                if (!value) {
                    return "Hours is required (use 0 for minutes only)";
                }
                const num = parseFloat(value);
                if (Number.isNaN(num) || num < 0) {
                    return "Must be a non-negative number";
                }
                return undefined;
            },
        });
        const hours = parseFloat(hoursInput);

        // Minutes
        let minutes = 0;
        if (hours === Math.floor(hours)) {
            const minutesInput = await p.text({
                message: "Additional minutes:",
                initialValue: "0",
            });
            minutes = parseInt(minutesInput || "0", 10);
        }

        const totalMinutes = convertToMinutes(hours, minutes);

        // Date
        const dateInput = await p.text({
            message: "Date (YYYY-MM-DD):",
            initialValue: getTodayDate(),
            validate: (value) => {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    return "Use YYYY-MM-DD format";
                }
                return undefined;
            },
        });

        // Comment
        const comment = await p.text({
            message: "Comment (optional):",
        });

        // Confirm
        out.print(`\n${"─".repeat(40)}`);
        out.print(`Work Item: #${workItemId}`);
        out.print(`Time: ${formatMinutes(totalMinutes)}`);
        out.print(`Type: ${selectedType}`);
        out.print(`Date: ${dateInput}`);
        if (comment) {
            out.print(`Comment: ${comment}`);
        }
        out.print("─".repeat(40));

        const confirmed = await p.confirm({
            message: "Create this time log entry?",
            initialValue: true,
        });

        if (!confirmed) {
            out.print("Cancelled");
            process.exit(0);
        }

        // Create entry
        out.print("\nCreating time log entry...");
        const ids = await api.createTimeLogEntry(workItemId, totalMinutes, selectedType, dateInput, comment);

        out.print(`\n✔ Time log created! Entry ID: ${ids[0]}`);
    } catch (error) {
        throw error;
    }
}
