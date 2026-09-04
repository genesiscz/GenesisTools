import { TimeLogApi } from "@app/azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { getConfig, getMappingForWorkItem, requireConfig, saveConfig } from "@app/clarity/config";
import { applyAssignments } from "@app/clarity/lib/assignments";
import { listClarityTasks } from "@app/clarity/lib/tasks";
import { getTimelogWorkItems, type TimelogWorkItemGroup } from "@app/clarity/lib/timelog-workitems";
import { getTimesheetWeeks, hasTimesheetId, type IdentifiedTimesheetWeek } from "@app/clarity/lib/timesheet-weeks";
import type { ClarityTask } from "@app/clarity/lib/types";
import * as clack from "@clack/prompts";
import { ClarityApi } from "@genesiscz/utils/clarity";
import pc from "picocolors";

const MONTH_NAMES = [
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

function formatWeekLabel(week: IdentifiedTimesheetWeek): string {
    const start = new Date(week.startDate);
    const end = new Date(week.finishDate);
    const fmt = (d: Date) => `${d.getDate()}.${d.getMonth() + 1}.`;

    return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * The mapping wizard: pick a week, pick one of its Clarity tasks, then multi-select the ADO work
 * items that bill it. This is the only interactive picker in the tool, and the flow the dashboard's
 * "Step 1/2/3" mirrors.
 */
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

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const monthResult = await clack.select({
        message: "Select month:",
        options: Array.from({ length: 12 }, (_, i) => ({
            value: i + 1,
            label: MONTH_NAMES[i],
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

    const weeksSpinner = clack.spinner();
    weeksSpinner.start(`Loading timesheet weeks for ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}...`);

    let selectableWeeks: IdentifiedTimesheetWeek[];

    try {
        const result = await getTimesheetWeeks(api, selectedMonth, selectedYear);
        // A period Clarity has not opened a timesheet for has no id to read entries with, so it
        // cannot be picked here at all.
        selectableWeeks = result.weeks.filter(hasTimesheetId);
        weeksSpinner.stop(`Found ${selectableWeeks.length} weeks`);
    } catch (err) {
        weeksSpinner.stop("Failed to load weeks");
        clack.log.error(err instanceof Error ? err.message : String(err));
        return;
    }

    if (selectableWeeks.length === 0) {
        clack.log.warn("No timesheet weeks found.");
        clack.outro("Done");
        return;
    }

    let step = 1;
    let selectedWeek: IdentifiedTimesheetWeek | null = null;
    let selectedTask: ClarityTask | null = null;
    let tasks: ClarityTask[] = [];
    let workItems: TimelogWorkItemGroup[] = [];

    while (step > 0) {
        if (step === 1) {
            const result = await clack.select({
                message: "Select timesheet week:",
                options: selectableWeeks.map((w) => ({
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

            const tsSpinner = clack.spinner();
            tsSpinner.start("Loading timesheet entries...");

            try {
                tasks = await listClarityTasks({ api, timesheetId: selectedWeek.timesheetId });
                tsSpinner.stop(`Found ${tasks.length} Clarity tasks`);
            } catch (err) {
                tsSpinner.stop("Failed to load timesheet");
                clack.log.error(err instanceof Error ? err.message : String(err));
                continue;
            }

            if (tasks.length === 0) {
                clack.log.warn("No time entries found in this timesheet.");
                continue;
            }

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

                const startMonth = new Date(selectedWeek.startDate).getUTCMonth() + 1;
                const startYear = new Date(selectedWeek.startDate).getUTCFullYear();
                const endMonth = new Date(selectedWeek.finishDate).getUTCMonth() + 1;
                const endYear = new Date(selectedWeek.finishDate).getUTCFullYear();

                if (startMonth !== endMonth || startYear !== endYear) {
                    const adjMonth = startMonth !== selectedMonth ? startMonth : endMonth;
                    const adjYear = startYear !== selectedYear ? startYear : endYear;
                    const adjResult = await getTimelogWorkItems(adoApi, adoConfig, adjMonth, adjYear, adoUser.userId);
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
            const result = await clack.select({
                message: "Select Clarity task to link to:",
                options: tasks.map((task) => ({
                    value: task.taskId,
                    label: `${task.taskName} [${task.investmentName}]`,
                    hint: `code: ${task.taskCode}`,
                })),
            });

            if (clack.isCancel(result)) {
                step = 1;
                continue;
            }

            selectedTask = tasks.find((task) => task.taskId === result) ?? null;
            step = 3;
        } else if (step === 3) {
            if (!selectedTask) {
                step = 2;
                continue;
            }

            // Captured so the narrowing survives into the callbacks below; `selectedTask` is a
            // `let` the loop reassigns, which TypeScript will not narrow across a closure.
            const chosenTask = selectedTask;

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
            const result = await clack.multiselect({
                message: showMapped
                    ? `Select ADO work items to RE-MAP to ${chosenTask.taskName} (unchecked items keep their current task):`
                    : `Select ADO work items to link (${mapped.length} already mapped, hidden):`,
                options: itemsToShow.map((wi) => {
                    const hours = (wi.totalMinutes / 60).toFixed(1);
                    const existing = getMappingForWorkItem(mappings, wi.id);
                    const hint = existing ? `mapped → ${existing.clarityTaskName}` : `${wi.type}, ${hours}h`;

                    return { value: wi, label: `#${wi.id} ${wi.title}`, hint };
                }),
                required: false,
            });

            if (clack.isCancel(result)) {
                step = 2;
                continue;
            }

            step = 4;

            const selected = result ?? [];

            if (selected.length === 0) {
                clack.log.warn("Nothing selected, so nothing changed.");
                step = 3;
                continue;
            }

            const freshConfig = await requireConfig();
            const repointed = selected.filter((wi) => {
                const existing = getMappingForWorkItem(freshConfig.mappings, wi.id);

                return existing && existing.clarityTaskId !== chosenTask.taskId;
            });

            for (const wi of repointed) {
                const existing = getMappingForWorkItem(freshConfig.mappings, wi.id);
                clack.log.warn(`#${wi.id} moves from ${existing?.clarityTaskName} to ${chosenTask.taskName}`);
            }

            const confirmed = await clack.confirm({
                message: `Map ${selected.length} work item${selected.length > 1 ? "s" : ""} to ${chosenTask.taskName}?`,
            });

            if (clack.isCancel(confirmed) || !confirmed) {
                step = 3;
                continue;
            }

            freshConfig.mappings = applyAssignments({
                mappings: freshConfig.mappings,
                pairs: selected.map((wi) => ({
                    workItemId: wi.id,
                    task: chosenTask,
                    title: wi.title,
                    type: wi.type || undefined,
                })),
            });

            await saveConfig(freshConfig);

            for (const wi of selected) {
                clack.log.success(`Linked: ADO #${wi.id} → ${chosenTask.taskName}`);
            }

            const again = await clack.confirm({ message: "Add more mappings?", initialValue: false });

            if (clack.isCancel(again) || !again) {
                step = 0;
                continue;
            }

            step = 2;
        }
    }

    clack.outro("Done");
}
