import { ClarityApi } from "@app/utils/clarity";
import type { TimeEntryRecord } from "@app/utils/clarity";
import { getConfig, saveConfig } from "../config.js";
import type { ClarityMapping } from "../config.js";
import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

interface ClarityProject {
    taskId: number;
    taskName: string;
    taskCode: string;
    investmentName: string;
    investmentCode: string;
    timeEntryId: number;
}

function extractProjects(entries: TimeEntryRecord[]): ClarityProject[] {
    return entries.map((e) => ({
        taskId: e.taskId,
        taskName: e.taskName,
        taskCode: e.taskCode,
        investmentName: e.investmentName,
        investmentCode: e.investmentCode,
        timeEntryId: e._internalId,
    }));
}

async function runInteractiveLinking(): Promise<void> {
    const config = await getConfig();

    if (!config) {
        console.error("Clarity not configured. Run: tools clarity configure");
        process.exit(1);
    }

    clack.intro(pc.bgCyan(pc.black(" Link ADO Work Items to Clarity Tasks ")));

    const timesheetIdInput = await clack.text({
        message: "Enter a Clarity timesheet ID to load available tasks:",
        placeholder: "e.g. 8524081",
        validate(value) {
            if (!value?.trim() || Number.isNaN(parseInt(value, 10))) {
                return "Enter a valid numeric timesheet ID";
            }
        },
    });

    if (clack.isCancel(timesheetIdInput)) {
        clack.cancel("Cancelled.");
        return;
    }

    const api = new ClarityApi({
        baseUrl: config.baseUrl,
        authToken: config.authToken,
        sessionId: config.sessionId,
    });

    const spinner = clack.spinner();
    spinner.start("Loading timesheet entries...");

    let projects: ClarityProject[];

    try {
        const data = await api.getTimesheet(parseInt(timesheetIdInput, 10));
        const ts = data.timesheets._results[0];

        if (!ts) {
            spinner.stop("Timesheet not found");
            process.exit(1);
        }

        projects = extractProjects(ts.timeentries._results);
        spinner.stop(`Found ${projects.length} Clarity tasks`);
    } catch (err) {
        spinner.stop("Failed to load timesheet");
        clack.log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    if (projects.length === 0) {
        clack.log.warn("No time entries found in this timesheet.");
        clack.outro("Done");
        return;
    }

    // Show existing mappings
    if (config.mappings.length > 0) {
        clack.log.info(`\n${pc.bold("Existing mappings:")}`);

        for (const m of config.mappings) {
            clack.log.info(`  ADO #${m.adoWorkItemId} -> ${m.clarityTaskName}`);
        }

        console.log();
    }

    // Select Clarity task
    const selectedTask = await clack.select({
        message: "Select a Clarity task to link:",
        options: projects.map((p) => ({
            value: p,
            label: `${p.taskName} [${p.investmentName}]`,
            hint: `code: ${p.taskCode}`,
        })),
    });

    if (clack.isCancel(selectedTask)) {
        clack.cancel("Cancelled.");
        return;
    }

    const project = selectedTask as ClarityProject;

    // Get ADO work item ID
    const adoIdInput = await clack.text({
        message: "Enter the ADO Work Item ID to link:",
        placeholder: "e.g. 268935",
        validate(value) {
            if (!value?.trim() || Number.isNaN(parseInt(value, 10))) {
                return "Enter a valid numeric work item ID";
            }
        },
    });

    if (clack.isCancel(adoIdInput)) {
        clack.cancel("Cancelled.");
        return;
    }

    const adoWorkItemId = parseInt(adoIdInput, 10);

    const adoTitleInput = await clack.text({
        message: "ADO Work Item title (for reference):",
        placeholder: "e.g. Feature X Development",
    });

    if (clack.isCancel(adoTitleInput)) {
        clack.cancel("Cancelled.");
        return;
    }

    // Check for existing mapping
    const existingIdx = config.mappings.findIndex((m) => m.adoWorkItemId === adoWorkItemId);

    if (existingIdx !== -1) {
        const overwrite = await clack.confirm({
            message: `ADO #${adoWorkItemId} is already mapped to ${config.mappings[existingIdx].clarityTaskName}. Overwrite?`,
            initialValue: false,
        });

        if (clack.isCancel(overwrite) || !overwrite) {
            clack.cancel("Cancelled.");
            return;
        }

        config.mappings.splice(existingIdx, 1);
    }

    const mapping: ClarityMapping = {
        clarityTaskId: project.taskId,
        clarityTaskName: project.taskName,
        clarityTaskCode: project.taskCode,
        clarityInvestmentName: project.investmentName,
        clarityInvestmentCode: project.investmentCode,
        clarityTimesheetId: parseInt(timesheetIdInput, 10),
        clarityTimeEntryId: project.timeEntryId,
        adoWorkItemId,
        adoWorkItemTitle: adoTitleInput,
    };

    config.mappings.push(mapping);
    await saveConfig(config);

    clack.outro(
        pc.green(`Linked: ADO #${adoWorkItemId} -> ${project.taskName} [${project.investmentName}]`)
    );
}

export function registerLinkCommand(program: Command): void {
    const cmd = program
        .command("link-workitems")
        .description("Link ADO work items to Clarity tasks")
        .option("--list", "List current mappings and available tasks")
        .option("--azure-devops-workitem <id>", "ADO work item ID (non-interactive)", parseInt)
        .option("--clarity-task <name>", "Clarity task name (non-interactive)")
        .option("--clarity-task-id <id>", "Clarity internal task ID (non-interactive)", parseInt)
        .option("--timesheet <id>", "Timesheet ID to look up task info", parseInt)
        .option("--unlink <id>", "Remove mapping for ADO work item ID", parseInt);

    cmd.action(
        async (options: {
            list?: boolean;
            azureDevopsWorkitem?: number;
            clarityTask?: string;
            clarityTaskId?: number;
            timesheet?: number;
            unlink?: number;
        }) => {
            const config = await getConfig();

            if (!config) {
                console.error("Clarity not configured. Run: tools clarity configure");
                process.exit(1);
            }

            // Unlink
            if (options.unlink !== undefined) {
                const idx = config.mappings.findIndex((m) => m.adoWorkItemId === options.unlink);

                if (idx === -1) {
                    console.error(`No mapping found for ADO work item #${options.unlink}`);
                    process.exit(1);
                }

                const removed = config.mappings.splice(idx, 1)[0];
                await saveConfig(config);
                console.log(`Removed mapping: ADO #${removed.adoWorkItemId} -> ${removed.clarityTaskName}`);
                return;
            }

            // List
            if (options.list) {
                console.log(JSON.stringify({ mappings: config.mappings }, null, 2));
                return;
            }

            // Non-interactive linking
            if (options.azureDevopsWorkitem !== undefined && (options.clarityTask || options.clarityTaskId !== undefined)) {
                if (!options.timesheet) {
                    console.error("--timesheet <id> is required for non-interactive linking (to look up task details)");
                    process.exit(1);
                }

                const api = new ClarityApi({
                    baseUrl: config.baseUrl,
                    authToken: config.authToken,
                    sessionId: config.sessionId,
                });

                const data = await api.getTimesheet(options.timesheet);
                const ts = data.timesheets._results[0];

                if (!ts) {
                    console.error(`Timesheet ${options.timesheet} not found`);
                    process.exit(1);
                }

                const projects = extractProjects(ts.timeentries._results);
                let project: ClarityProject | undefined;

                if (options.clarityTaskId !== undefined) {
                    project = projects.find((p) => p.taskId === options.clarityTaskId);
                } else if (options.clarityTask) {
                    project = projects.find(
                        (p) =>
                            p.taskName === options.clarityTask ||
                            p.taskName.toLowerCase().includes(options.clarityTask!.toLowerCase())
                    );
                }

                if (!project) {
                    console.error(
                        `Clarity task not found. Available tasks:\n${projects.map((p) => `  - ${p.taskName} (id: ${p.taskId})`).join("\n")}`
                    );
                    process.exit(1);
                }

                // Remove existing if any
                const existingIdx = config.mappings.findIndex(
                    (m) => m.adoWorkItemId === options.azureDevopsWorkitem
                );

                if (existingIdx !== -1) {
                    config.mappings.splice(existingIdx, 1);
                }

                const mapping: ClarityMapping = {
                    clarityTaskId: project.taskId,
                    clarityTaskName: project.taskName,
                    clarityTaskCode: project.taskCode,
                    clarityInvestmentName: project.investmentName,
                    clarityInvestmentCode: project.investmentCode,
                    clarityTimesheetId: options.timesheet,
                    clarityTimeEntryId: project.timeEntryId,
                    adoWorkItemId: options.azureDevopsWorkitem,
                    adoWorkItemTitle: `WI #${options.azureDevopsWorkitem}`,
                };

                config.mappings.push(mapping);
                await saveConfig(config);
                console.log(`Linked: ADO #${options.azureDevopsWorkitem} -> ${project.taskName}`);
                return;
            }

            // Interactive mode
            await runInteractiveLinking();
        }
    );
}
