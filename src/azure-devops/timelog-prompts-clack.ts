/**
 * TimeLog Interactive Prompts - @clack/prompts implementation
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { TimeLogApi, formatMinutes, getTodayDate, convertToMinutes } from "@app/azure-devops/timelog-api";
import type { TimeLogUser, AzureConfigWithTimeLog } from "@app/azure-devops/types";

export async function runInteractiveAddClack(
    config: AzureConfigWithTimeLog,
    user: TimeLogUser,
    prefilledWorkItem?: string
): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" TimeLog - Add Entry ")));

    const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

    // Fetch time types
    const spinner = p.spinner();
    spinner.start("Loading time types...");
    const types = await api.getTimeTypes();
    spinner.stop("Time types loaded");

    // Work item ID
    let workItemId: number;
    if (prefilledWorkItem) {
        workItemId = parseInt(prefilledWorkItem, 10);
        p.log.info(`Work Item: #${workItemId}`);
    } else {
        const workItemInput = await p.text({
            message: "Work Item ID:",
            placeholder: "268935",
            validate: (value) => {
                if (!value) return "Work item ID is required";
                if (isNaN(parseInt(value, 10))) return "Must be a number";
                return undefined;
            },
        });
        if (p.isCancel(workItemInput)) {
            p.cancel("Cancelled");
            process.exit(0);
        }
        workItemId = parseInt(workItemInput, 10);
    }

    // Time type
    const typeOptions = types.map((t) => ({
        value: t.description,
        label: t.description,
        hint: t.isDefaultForProject ? "default" : undefined,
    }));

    const selectedType = await p.select({
        message: "Time Type:",
        options: typeOptions,
        initialValue: types.find((t) => t.isDefaultForProject)?.description,
    });
    if (p.isCancel(selectedType)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    // Hours
    const hoursInput = await p.text({
        message: "Hours:",
        placeholder: "2",
        validate: (value) => {
            if (!value) return "Hours is required (use 0 for minutes only)";
            const num = parseFloat(value);
            if (isNaN(num) || num < 0) return "Must be a non-negative number";
            return undefined;
        },
    });
    if (p.isCancel(hoursInput)) {
        p.cancel("Cancelled");
        process.exit(0);
    }
    const hours = parseFloat(hoursInput);

    // Minutes (optional)
    let minutes = 0;
    if (hours === 0 || hours % 1 !== 0) {
        // If hours is 0 or has decimals, skip additional minutes
    } else {
        const minutesInput = await p.text({
            message: "Additional minutes (optional):",
            placeholder: "0",
            initialValue: "0",
        });
        if (p.isCancel(minutesInput)) {
            p.cancel("Cancelled");
            process.exit(0);
        }
        minutes = parseInt(minutesInput || "0", 10);
    }

    const totalMinutes = convertToMinutes(hours, minutes);

    // Date
    const dateInput = await p.text({
        message: "Date:",
        placeholder: getTodayDate(),
        initialValue: getTodayDate(),
        validate: (value) => {
            if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                return "Use YYYY-MM-DD format";
            }
            return undefined;
        },
    });
    if (p.isCancel(dateInput)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    // Comment
    const commentInput = await p.text({
        message: "Comment (optional):",
        placeholder: "Description of work performed",
    });
    if (p.isCancel(commentInput)) {
        p.cancel("Cancelled");
        process.exit(0);
    }
    const comment = commentInput || "";

    // Confirm
    p.log.info(pc.dim("─".repeat(40)));
    p.log.info(`Work Item: #${workItemId}`);
    p.log.info(`Time: ${formatMinutes(totalMinutes)}`);
    p.log.info(`Type: ${selectedType}`);
    p.log.info(`Date: ${dateInput}`);
    if (comment) p.log.info(`Comment: ${comment}`);
    p.log.info(pc.dim("─".repeat(40)));

    const confirm = await p.confirm({
        message: "Create this time log entry?",
        initialValue: true,
    });
    if (p.isCancel(confirm) || !confirm) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    // Create entry
    spinner.start("Creating time log entry...");
    const ids = await api.createTimeLogEntry(workItemId, totalMinutes, selectedType as string, dateInput, comment);
    spinner.stop("Time log created!");

    p.outro(pc.green(`✔ Entry ID: ${ids[0]}`));
}
