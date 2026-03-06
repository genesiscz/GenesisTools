import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import { ClarityApi } from "@app/utils/clarity";
import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { ClarityMapping } from "../config.js";
import { getConfig, getMappingForWorkItem, requireConfig, saveConfig } from "../config.js";
import { getTimesheetWeeks, type TimesheetWeek } from "../lib/timesheet-weeks.js";
import { getTimelogWorkItems, type TimelogWorkItemGroup } from "../lib/timelog-workitems.js";

interface ClarityProject {
    taskId: number;
    taskName: string;
    taskCode: string;
    investmentName: string;
    investmentCode: string;
    timeEntryId: number;
}

function extractProjects(entries: Array<{ taskId: number; taskName: string; taskCode: string; investmentName: string; investmentCode: string; _internalId: number }>): ClarityProject[] {
    return entries.map((e) => ({
        taskId: e.taskId,
        taskName: e.taskName,
        taskCode: e.taskCode,
        investmentName: e.investmentName,
        investmentCode: e.investmentCode,
        timeEntryId: e._internalId,
    }));
}

function formatWeekLabel(w: TimesheetWeek): string {
    const start = new Date(w.startDate);
    const end = new Date(w.finishDate);
    const fmt = (d: Date) => `${d.getDate()}.${d.getMonth() + 1}`;
    return `${fmt(start)} – ${fmt(end)}`;
}

async function runInteractiveLinking(): Promise<void> {
    const config = await requireConfig();

    clack.intro(pc.bgCyan(pc.black(" Link ADO Work Items to Clarity Tasks ")));

    const api = new ClarityApi({
        baseUrl: config.baseUrl,
        authToken: config.authToken,
        sessionId: config.sessionId,
    });

    const adoConfig = requireTimeLogConfig();
    const adoUser = requireTimeLogUser(adoConfig);
    const adoApi = new TimeLogApi(
        adoConfig.orgId!,
        adoConfig.projectId,
        adoConfig.timelog!.functionsKey,
        adoUser
    );

    // Load weeks
    const weeksSpinner = clack.spinner();
    weeksSpinner.start("Loading timesheet weeks...");

    let weeks: TimesheetWeek[];

    try {
        const result = await getTimesheetWeeks(api, config.mappings);
        weeks = result.weeks;
        weeksSpinner.stop(`Found ${weeks.length} weeks`);
    } catch (err) {
        weeksSpinner.stop("Failed to load weeks");
        clack.log.error(err instanceof Error ? err.message : String(err));
        return;
    }

    if (weeks.length === 0) {
        clack.log.warn("No timesheet weeks found.");
        clack.outro("Done");
        return;
    }

    // State machine
    let step = 1;
    let selectedWeek: TimesheetWeek | null = null;
    let selectedTask: ClarityProject | null = null;
    let projects: ClarityProject[] = [];
    let workItems: TimelogWorkItemGroup[] = [];

    while (step > 0) {
        if (step === 1) {
            // Step 1: Select week
            const result = await clack.select({
                message: "Select timesheet week:",
                options: weeks.map((w) => ({
                    value: w,
                    label: formatWeekLabel(w),
                    hint: `${w.totalHours}h – ${w.status}`,
                })),
            });

            if (clack.isCancel(result)) {
                step = 0;
                continue;
            }

            selectedWeek = result;

            // Load timesheet entries for the selected week
            const tsSpinner = clack.spinner();
            tsSpinner.start("Loading timesheet entries...");

            try {
                const data = await api.getTimesheet(selectedWeek.timesheetId);
                const ts = data.timesheets._results[0];

                if (!ts) {
                    tsSpinner.stop("Timesheet not found");
                    continue;
                }

                projects = extractProjects(ts.timeentries._results);
                tsSpinner.stop(`Found ${projects.length} Clarity tasks`);
            } catch (err) {
                tsSpinner.stop("Failed to load timesheet");
                clack.log.error(err instanceof Error ? err.message : String(err));
                continue;
            }

            if (projects.length === 0) {
                clack.log.warn("No time entries found in this timesheet.");
                continue;
            }

            // Also load timelog work items for the week's month
            const weekDate = new Date(selectedWeek.startDate);
            const month = weekDate.getMonth() + 1;
            const year = weekDate.getFullYear();

            const wiSpinner = clack.spinner();
            wiSpinner.start("Loading ADO timelog entries...");

            try {
                const result = await getTimelogWorkItems(adoApi, adoConfig, month, year, adoUser.userId);
                workItems = result.workItems;
                wiSpinner.stop(`Found ${workItems.length} work items`);
            } catch (err) {
                wiSpinner.stop("Failed to load timelog entries");
                clack.log.error(err instanceof Error ? err.message : String(err));
                workItems = [];
            }

            step = 2;
        } else if (step === 2) {
            // Step 2: Select Clarity task
            const result = await clack.select({
                message: "Select Clarity task to link to:",
                options: projects.map((p) => ({
                    value: p,
                    label: `${p.taskName} [${p.investmentName}]`,
                    hint: `code: ${p.taskCode}`,
                })),
            });

            if (clack.isCancel(result)) {
                step = 1;
                continue;
            }

            selectedTask = result;
            step = 3;
        } else if (step === 3) {
            // Step 3: Multi-select ADO work items
            if (workItems.length === 0) {
                clack.log.warn("No timelog work items found for this period.");
                step = 2;
                continue;
            }

            const currentConfig = await getConfig();
            const mappings = currentConfig?.mappings ?? [];

            const result = await clack.multiselect({
                message: "Select ADO work items to link:",
                options: workItems.map((wi) => {
                    const hours = (wi.totalMinutes / 60).toFixed(1);
                    const existing = getMappingForWorkItem(mappings, wi.id);
                    const hint = existing
                        ? `MAPPED → ${existing.clarityTaskName}`
                        : `${wi.type}, ${hours}h`;

                    return {
                        value: wi,
                        label: `#${wi.id} ${wi.title}`,
                        hint,
                    };
                }),
                required: true,
            });

            if (clack.isCancel(result)) {
                step = 2;
                continue;
            }

            step = 4;

            // Step 4: Confirm & save
            const selected = result;
            const confirmMsg = `Link ${selected.length} work item${selected.length > 1 ? "s" : ""} to ${selectedTask!.taskName}?`;

            const confirmed = await clack.confirm({
                message: confirmMsg,
            });

            if (clack.isCancel(confirmed) || !confirmed) {
                step = 3;
                continue;
            }

            // Save mappings
            const freshConfig = await requireConfig();

            for (const wi of selected) {
                // Remove existing mapping if any
                const existingIdx = freshConfig.mappings.findIndex((m) => m.adoWorkItemId === wi.id);

                if (existingIdx !== -1) {
                    freshConfig.mappings.splice(existingIdx, 1);
                }

                const mapping: ClarityMapping = {
                    clarityTaskId: selectedTask!.taskId,
                    clarityTaskName: selectedTask!.taskName,
                    clarityTaskCode: selectedTask!.taskCode,
                    clarityInvestmentName: selectedTask!.investmentName,
                    clarityInvestmentCode: selectedTask!.investmentCode,
                    clarityTimesheetId: selectedWeek!.timesheetId,
                    clarityTimeEntryId: selectedTask!.timeEntryId,
                    adoWorkItemId: wi.id,
                    adoWorkItemTitle: wi.title,
                    adoWorkItemType: wi.type || undefined,
                };

                freshConfig.mappings.push(mapping);
            }

            await saveConfig(freshConfig);

            for (const wi of selected) {
                clack.log.success(`Linked: ADO #${wi.id} → ${selectedTask!.taskName}`);
            }

            // Ask to add more
            const again = await clack.confirm({
                message: "Add more mappings?",
                initialValue: false,
            });

            if (clack.isCancel(again) || !again) {
                step = 0;
                continue;
            }

            step = 2;
        }
    }

    clack.outro("Done");
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
            if (
                options.azureDevopsWorkitem !== undefined &&
                (options.clarityTask || options.clarityTaskId !== undefined)
            ) {
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
                const existingIdx = config.mappings.findIndex((m) => m.adoWorkItemId === options.azureDevopsWorkitem);

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
