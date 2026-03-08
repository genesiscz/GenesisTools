import { TimeLogApi } from "@app/azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { ClarityApi } from "@app/utils/clarity";
import * as clack from "@clack/prompts";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import type { ClarityMapping } from "../config.js";
import { getConfig, getMappingForWorkItem, requireConfig, saveConfig } from "../config.js";
import { getTimelogWorkItems, type TimelogWorkItemGroup } from "../lib/timelog-workitems.js";
import { getTimesheetWeeks, type TimesheetWeek } from "../lib/timesheet-weeks.js";

interface ClarityProject {
    taskId: number;
    taskName: string;
    taskCode: string;
    investmentName: string;
    investmentCode: string;
    timeEntryId: number;
}

function extractProjects(
    entries: Array<{
        taskId: number;
        taskName: string;
        taskCode: string;
        investmentName: string;
        investmentCode: string;
        _internalId: number;
    }>
): ClarityProject[] {
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

export async function runInteractiveLinking(): Promise<void> {
    const config = await requireConfig();

    clack.intro(pc.bgCyan(pc.black(" Link ADO Work Items to Clarity Tasks ")));

    const api = new ClarityApi({
        baseUrl: config.baseUrl,
        authToken: config.authToken,
        sessionId: config.sessionId,
        cookies: config.cookies,
    });

    const adoConfig = requireTimeLogConfig();
    const adoUser = requireTimeLogUser(adoConfig);
    const adoApi = new TimeLogApi(adoConfig.orgId!, adoConfig.projectId, adoConfig.timelog!.functionsKey, adoUser);

    // Ask for month/year
    const now = new Date();
    const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const monthResult = await clack.select({
        message: "Select month:",
        options: Array.from({ length: 12 }, (_, i) => ({
            value: i + 1,
            label: monthNames[i],
            hint: i + 1 === currentMonth ? "current" : undefined,
        })),
        initialValue: currentMonth,
    });

    if (clack.isCancel(monthResult)) {
        clack.outro("Cancelled");
        return;
    }

    const selectedMonth = monthResult;

    const yearResult = await clack.select({
        message: "Select year:",
        options: [currentYear - 1, currentYear, currentYear + 1].map((y) => ({
            value: y,
            label: String(y),
            hint: y === currentYear ? "current" : undefined,
        })),
        initialValue: currentYear,
    });

    if (clack.isCancel(yearResult)) {
        clack.outro("Cancelled");
        return;
    }

    const selectedYear = yearResult;

    // Load weeks
    const weeksSpinner = clack.spinner();
    weeksSpinner.start(`Loading timesheet weeks for ${monthNames[selectedMonth - 1]} ${selectedYear}...`);

    let weeks: TimesheetWeek[];

    try {
        const result = await getTimesheetWeeks(api, config.mappings, selectedMonth, selectedYear);
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

            // Load timelog work items for the selected month
            // If the week spans a month boundary, also load the adjacent month and merge
            const wiSpinner = clack.spinner();
            wiSpinner.start("Loading ADO timelog entries...");

            try {
                const result = await getTimelogWorkItems(
                    adoApi,
                    adoConfig,
                    selectedMonth,
                    selectedYear,
                    adoUser.userId
                );
                workItems = result.workItems;

                // Check if the selected week spans into a different month
                const startMonth = new Date(selectedWeek.startDate).getUTCMonth() + 1;
                const startYear = new Date(selectedWeek.startDate).getUTCFullYear();
                const endMonth = new Date(selectedWeek.finishDate).getUTCMonth() + 1;
                const endYear = new Date(selectedWeek.finishDate).getUTCFullYear();

                if (startMonth !== endMonth || startYear !== endYear) {
                    const adjMonth = startMonth !== selectedMonth ? startMonth : endMonth;
                    const adjYear = startYear !== selectedYear ? startYear : endYear;
                    const adjResult = await getTimelogWorkItems(adoApi, adoConfig, adjMonth, adjYear, adoUser.userId);

                    // Merge: add items not already present
                    const existingIds = new Set(workItems.map((wi) => wi.id));

                    for (const wi of adjResult.workItems) {
                        if (!existingIds.has(wi.id)) {
                            workItems.push(wi);
                        }
                    }
                }

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
                    value: p.taskId,
                    label: `${p.taskName} [${p.investmentName}]`,
                    hint: `code: ${p.taskCode}`,
                })),
            });

            if (clack.isCancel(result)) {
                step = 1;
                continue;
            }

            selectedTask = projects.find((p) => p.taskId === result) ?? null;
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

            const unmapped = workItems.filter((wi) => !getMappingForWorkItem(mappings, wi.id));
            const mapped = workItems.filter((wi) => getMappingForWorkItem(mappings, wi.id));

            if (unmapped.length === 0) {
                clack.log.info("All work items are already mapped.");

                const showAll = await clack.confirm({
                    message: `Show ${mapped.length} already-mapped items to re-assign?`,
                    initialValue: false,
                });

                if (clack.isCancel(showAll) || !showAll) {
                    step = 2;
                    continue;
                }
            }

            const showMapped = unmapped.length === 0;
            const itemsToShow = showMapped ? workItems : unmapped;

            const mappedItems = showMapped ? itemsToShow.filter((wi) => getMappingForWorkItem(mappings, wi.id)) : [];

            const result = await clack.multiselect({
                message: showMapped
                    ? "Select ADO work items to keep mapped (deselect to unmap):"
                    : `Select ADO work items to link (${mapped.length} already mapped, hidden):`,
                options: itemsToShow.map((wi) => {
                    const hours = (wi.totalMinutes / 60).toFixed(1);
                    const existing = getMappingForWorkItem(mappings, wi.id);
                    const hint = existing ? `mapped → ${existing.clarityTaskName}` : `${wi.type}, ${hours}h`;

                    return {
                        value: wi,
                        label: `#${wi.id} ${wi.title}`,
                        hint,
                    };
                }),
                initialValues: mappedItems,
                required: false,
            });

            if (clack.isCancel(result)) {
                step = 2;
                continue;
            }

            step = 4;

            // Step 4: Confirm & save
            const selected = result ?? [];
            const deselected = showMapped ? mappedItems.filter((mi) => !selected.some((s) => s.id === mi.id)) : [];

            const parts: string[] = [];

            if (selected.length > 0) {
                parts.push(
                    `link ${selected.length} work item${selected.length > 1 ? "s" : ""} to ${selectedTask!.taskName}`
                );
            }

            if (deselected.length > 0) {
                parts.push(`unmap ${deselected.length} work item${deselected.length > 1 ? "s" : ""}`);
            }

            if (parts.length === 0) {
                clack.log.warn("No changes to make.");
                step = 3;
                continue;
            }

            const confirmMsg = `${parts.join(" and ")}?`;

            const confirmed = await clack.confirm({
                message: confirmMsg.charAt(0).toUpperCase() + confirmMsg.slice(1),
            });

            if (clack.isCancel(confirmed) || !confirmed) {
                step = 3;
                continue;
            }

            // Save mappings
            const freshConfig = await requireConfig();

            // Remove deselected (unmapped) items
            for (const wi of deselected) {
                const idx = freshConfig.mappings.findIndex((m) => m.adoWorkItemId === wi.id);

                if (idx !== -1) {
                    freshConfig.mappings.splice(idx, 1);
                    clack.log.info(`Unmapped: ADO #${wi.id}`);
                }
            }

            // Add/re-assign selected items
            for (const wi of selected) {
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
                clack.log.success(`Linked: ADO #${wi.id} → ${selectedTask!.taskName}`);
            }

            await saveConfig(freshConfig);

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

function parseIntegerOption(value: string, optionName: string): number {
    const trimmed = value.trim();

    if (!/^\d+$/.test(trimmed)) {
        throw new InvalidArgumentError(`${optionName} must be a valid integer`);
    }

    return Number(trimmed);
}

export function registerLinkCommand(program: Command): void {
    const cmd = program
        .command("link-workitems")
        .description("Link ADO work items to Clarity tasks")
        .option("--list", "List current mappings")
        .option("--azure-devops-workitem <id>", "ADO work item ID (non-interactive)", (v) =>
            parseIntegerOption(v, "--azure-devops-workitem")
        )
        .option("--clarity-task <name>", "Clarity task name (non-interactive)")
        .option("--clarity-task-id <id>", "Clarity internal task ID (non-interactive)", (v) =>
            parseIntegerOption(v, "--clarity-task-id")
        )
        .option("--timesheet <id>", "Timesheet ID to look up task info", (v) => parseIntegerOption(v, "--timesheet"))
        .option("--unlink <id>", "Remove mapping for ADO work item ID", (v) => parseIntegerOption(v, "--unlink"));

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
            const hasAnyNonInteractiveFlag =
                options.azureDevopsWorkitem !== undefined ||
                options.clarityTask !== undefined ||
                options.clarityTaskId !== undefined ||
                options.timesheet !== undefined;

            if (hasAnyNonInteractiveFlag) {
                const missing: string[] = [];

                if (options.azureDevopsWorkitem === undefined) {
                    missing.push("--azure-devops-workitem");
                }

                if (!options.clarityTask && options.clarityTaskId === undefined) {
                    missing.push("--clarity-task or --clarity-task-id");
                }

                if (!options.timesheet) {
                    missing.push("--timesheet");
                }

                if (missing.length > 0) {
                    console.error(`Non-interactive linking requires all flags. Missing: ${missing.join(", ")}`);
                    process.exit(1);
                }
            }

            if (
                options.azureDevopsWorkitem !== undefined &&
                (options.clarityTask || options.clarityTaskId !== undefined)
            ) {
                const api = new ClarityApi({
                    baseUrl: config.baseUrl,
                    authToken: config.authToken,
                    sessionId: config.sessionId,
                    cookies: config.cookies,
                });

                const timesheetId = options.timesheet!;
                let data: Awaited<ReturnType<typeof api.getTimesheet>>;

                try {
                    data = await api.getTimesheet(timesheetId);
                } catch (err) {
                    console.error(`Failed to fetch timesheet: ${err instanceof Error ? err.message : String(err)}`);
                    process.exit(1);
                }

                const ts = data.timesheets._results[0];

                if (!ts) {
                    console.error(`Timesheet ${timesheetId} not found`);
                    process.exit(1);
                }

                const projects = extractProjects(ts.timeentries._results);
                let project: ClarityProject | undefined;

                if (options.clarityTaskId !== undefined) {
                    project = projects.find((p) => p.taskId === options.clarityTaskId);
                } else if (options.clarityTask) {
                    // Try exact match first
                    project = projects.find((p) => p.taskName === options.clarityTask);

                    if (!project) {
                        // Fall back to substring match, but require exactly one result
                        const matches = projects.filter((p) =>
                            p.taskName.toLowerCase().includes(options.clarityTask!.toLowerCase())
                        );

                        if (matches.length === 1) {
                            project = matches[0];
                        } else if (matches.length > 1) {
                            console.error(
                                `Ambiguous --clarity-task "${options.clarityTask}" matched ${matches.length} tasks:\n` +
                                    matches.map((p) => `  - ${p.taskName} (id: ${p.taskId})`).join("\n") +
                                    `\nUse --clarity-task-id <id> for an exact match.`
                            );
                            process.exit(1);
                        }
                    }
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
