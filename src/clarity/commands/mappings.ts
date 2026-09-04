import { formatMinutes } from "@app/azure-devops/timelog-api";
import { type ClarityMapping, requireConfig, saveConfig } from "@app/clarity/config";
import { type AssignmentView, buildAssignmentView } from "@app/clarity/lib/assignment-view";
import {
    type AssignmentPair,
    type AssignmentRow,
    applyAssignments,
    recommendedPairsFor,
    removeAssignments,
    serialiseAssignmentRow,
} from "@app/clarity/lib/assignments";
import { runInteractiveLinking } from "@app/clarity/lib/interactive-linking";
import { assignReceipt, renderReceipt, unlinkReceipt } from "@app/clarity/lib/receipts";
import { findTaskByName } from "@app/clarity/lib/tasks";
import * as p from "@clack/prompts";
import { isInteractive } from "@genesiscz/utils/cli";
import { formatLocalDate } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

export interface MappingsOptions {
    date?: string;
    list?: boolean;
    assigned?: boolean;
    unassigned?: boolean;
    assign?: string[];
    workItem?: string[];
    clarityTask?: string;
    applyRecommended?: boolean;
    unlink?: string[];
    yes?: boolean;
    format: string;
}

export function registerMappingsCommand(parent: Command): void {
    parent
        .command("mappings")
        .description("The ADO work item to Clarity task mapping table")
        .option("--date <date>", "Month (YYYY-MM) whose ADO entries to consider, default: this month")
        .option("--list", "Every stored mapping, ADO work item and Clarity task")
        .option("--assigned", "ADO work items that already map to a Clarity task")
        .option("--unassigned", "ADO work items with logged time and no Clarity mapping")
        .option("--assign <pairs...>", "Create mappings as <workItemId>:<clarityTaskId>")
        .option("--work-item <ids...>", "ADO work item ids to map with --clarity-task")
        .option("--clarity-task <name>", "Clarity task name to map --work-item onto")
        .option("--apply-recommended", "Assign every unmapped work item that has a tree recommendation")
        .option("--unlink <ids...>", "Remove the mapping for these ADO work item ids")
        .option("--yes", "Skip the confirmation for unlinking or overwriting a mapping")
        .option("--format <format>", "Output format: table|json", "table")
        .addHelpText(
            "after",
            [
                "",
                "Examples:",
                "  tools clarity mappings                            the wizard, or --list when not a terminal",
                "  tools clarity mappings --date 2026-08 --unassigned  work items still missing a mapping",
                "  tools clarity mappings --date 2026-08 --assigned    mappings, with drift against the tree",
                "  tools clarity mappings --date 2026-08 --apply-recommended",
                "  tools clarity mappings --date 2026-08 --assign 302920:8898018",
                '  tools clarity mappings --work-item 302920 --clarity-task "Incidenty_Opex"',
                "  tools clarity mappings --unlink 298326 --yes",
                "",
            ].join("\n")
        )
        .action(async (options: MappingsOptions) => {
            await runMappings(options);
        });
}

export async function runMappings(options: MappingsOptions): Promise<void> {
    if (options.unlink) {
        await runUnlink(options);
        return;
    }

    if (options.list) {
        await runList(options);
        return;
    }

    const date = options.date ?? formatLocalDate(new Date());

    if (options.assign || options.applyRecommended || options.clarityTask || options.workItem) {
        await runAssign(date, options);
        return;
    }

    if (options.assigned || options.unassigned) {
        await runListing(date, options);
        return;
    }

    if (!isInteractive()) {
        await runList(options);
        return;
    }

    await runInteractiveLinking();
}

function serialiseMapping(mapping: ClarityMapping) {
    return {
        workItemId: mapping.adoWorkItemId,
        workItemTitle: mapping.adoWorkItemTitle,
        workItemType: mapping.adoWorkItemType,
        clarityTaskId: mapping.clarityTaskId,
        clarityTaskName: mapping.clarityTaskName,
        clarityInvestmentName: mapping.clarityInvestmentName,
    };
}

async function runList(options: MappingsOptions): Promise<void> {
    const config = await requireConfig();
    const mappings = [...config.mappings].sort((a, b) => a.adoWorkItemId - b.adoWorkItemId);

    if (options.format === "json") {
        out.result(mappings.map(serialiseMapping));
        return;
    }

    renderCliHeader("Clarity Mappings", `${mappings.length} stored`);
    const table = createBoxTable(["WI", "WORK ITEM", "CLARITY TASK"]);

    for (const mapping of mappings) {
        table.push([
            pc.white(`#${mapping.adoWorkItemId}`),
            truncateDisplay(mapping.adoWorkItemTitle, 42),
            truncateDisplay(mapping.clarityTaskName, 46),
        ]);
    }

    out.println(table.toString());
    out.println(pc.dim(`  ${mappings.length} mapping(s)`));
}

async function runListing(date: string, options: MappingsOptions): Promise<void> {
    const view = await buildAssignmentView(date);
    const wantAssigned = Boolean(options.assigned);
    const rows = wantAssigned ? view.assigned : view.unassigned;

    if (options.format === "json") {
        out.result(rows.map(serialiseAssignmentRow));
        return;
    }

    renderCliHeader("Clarity", `${wantAssigned ? "assigned" : "unassigned"} · ${date}`);
    const table = createBoxTable(
        wantAssigned ? ["WI", "HOURS", "MAPPED TO", "RECOMMENDED"] : ["WI", "HOURS", "WORK ITEM", "RECOMMENDED"]
    );

    for (const row of rows) {
        const rec = row.recommendation
            ? `${row.drifted ? pc.yellow("⚠ ") : ""}${truncateDisplay(row.recommendation.task.taskName, 38)} ${pc.dim(`(#${row.recommendation.matched.id})`)}`
            : pc.dim("—");

        table.push([
            pc.white(`#${row.workItemId}`),
            formatMinutes(row.minutes),
            wantAssigned
                ? truncateDisplay(row.mapping?.clarityTaskName ?? "—", 40)
                : truncateDisplay(row.title ?? "", 40),
            rec,
        ]);
    }

    out.println(table.toString());
    out.println(pc.dim(`  ${rows.length} work item(s)`));
}

function parseWorkItemId(raw: string, flag: string): number {
    const id = Number(raw);

    if (!Number.isInteger(id) || id <= 0 || raw.trim() === "") {
        out.error(`Invalid ${flag} id '${raw}': expected a work item id`);
        process.exit(1);
    }

    return id;
}

function rowFor(view: AssignmentView, workItemId: number): AssignmentRow | undefined {
    return [...view.assigned, ...view.unassigned].find((row) => row.workItemId === workItemId);
}

function collectPairs(view: AssignmentView, options: MappingsOptions): AssignmentPair[] {
    const pairs: AssignmentPair[] = [];

    for (const raw of options.assign ?? []) {
        const parts = raw.split(":");

        if (parts.length !== 2 || parts.some((part) => part.trim() === "")) {
            out.error(`Invalid --assign pair '${raw}': expected <workItemId>:<clarityTaskId>`);
            process.exit(1);
        }

        const workItemId = Number(parts[0]);
        const taskId = Number(parts[1]);

        if (!Number.isInteger(workItemId) || workItemId <= 0 || !Number.isInteger(taskId) || taskId <= 0) {
            out.error(`Invalid --assign pair '${raw}': expected positive <workItemId>:<clarityTaskId>`);
            process.exit(1);
        }

        const task = view.tasks.find((t) => t.taskId === taskId);

        if (!task) {
            out.error(`No Clarity task ${taskId} in the catalogue for this month`);
            process.exit(1);
        }

        const row = rowFor(view, workItemId);
        pairs.push({ workItemId, task, title: row?.title, type: row?.type });
    }

    if (options.clarityTask || options.workItem) {
        if (!options.clarityTask || !options.workItem) {
            out.error("--work-item and --clarity-task go together; supply both");
            process.exit(1);
        }

        const lookup = findTaskByName(view.tasks, options.clarityTask);

        if (lookup.ambiguous) {
            out.error(
                `Ambiguous --clarity-task "${options.clarityTask}" matched ${lookup.ambiguous.length} tasks:\n${lookup.ambiguous
                    .map((task) => `  - ${task.taskName} (id: ${task.taskId})`)
                    .join("\n")}\nUse --assign <workItemId>:<clarityTaskId> for an exact match.`
            );
            process.exit(1);
        }

        if (!lookup.task) {
            out.error(
                `Clarity task not found. Available tasks:\n${view.tasks
                    .map((task) => `  - ${task.taskName} (id: ${task.taskId})`)
                    .join("\n")}`
            );
            process.exit(1);
        }

        for (const raw of options.workItem) {
            const workItemId = parseWorkItemId(raw, "--work-item");
            const row = rowFor(view, workItemId);
            pairs.push({ workItemId, task: lookup.task, title: row?.title, type: row?.type });
        }
    }

    if (options.applyRecommended) {
        for (const pair of recommendedPairsFor(view)) {
            if (!pairs.some((known) => known.workItemId === pair.workItemId)) {
                pairs.push(pair);
            }
        }
    }

    return pairs;
}

async function runAssign(date: string, options: MappingsOptions): Promise<void> {
    const view = await buildAssignmentView(date);
    const pairs = collectPairs(view, options);

    if (pairs.length === 0) {
        out.println("Nothing to assign.");
        return;
    }

    const config = await requireConfig();
    // applyAssignments replaces in place, so a pair aimed at an already-mapped work item repoints
    // it. Creating a mapping is additive, but overwriting one loses a decision the user made by
    // hand, so it is named and gated before the write, not reported after it.
    const replaced = pairs
        .map((pair) => ({ pair, previous: config.mappings.find((m) => m.adoWorkItemId === pair.workItemId) }))
        .filter((entry) => entry.previous && entry.previous.clarityTaskId !== entry.pair.task.taskId);

    if (replaced.length > 0 && options.format !== "json") {
        for (const entry of replaced) {
            out.warn(
                pc.yellow(
                    `  replaces #${entry.pair.workItemId}: ${entry.previous?.clarityTaskName} → ${entry.pair.task.taskName}`
                )
            );
        }
    }

    if (replaced.length > 0 && !options.yes) {
        if (!isInteractive()) {
            out.error(`Refusing to overwrite ${replaced.length} existing mapping(s) without --yes`);
            process.exit(1);
        }

        const confirmed = await p.confirm({ message: `Overwrite ${replaced.length} existing mapping(s)?` });

        if (p.isCancel(confirmed) || !confirmed) {
            p.cancel("Cancelled");
            return;
        }
    }

    config.mappings = applyAssignments({ mappings: config.mappings, pairs });
    await saveConfig(config);

    if (options.format === "json") {
        out.result(
            pairs.map((pair) => ({
                workItemId: pair.workItemId,
                clarityTaskId: pair.task.taskId,
                clarityTaskName: pair.task.taskName,
            }))
        );
        return;
    }

    for (const pair of pairs) {
        out.println(`${pc.green("✔")} #${pair.workItemId} → ${pair.task.taskName}`);
    }

    const replacedIds = new Set(replaced.map((entry) => entry.pair.workItemId));

    renderReceipt(
        assignReceipt({
            created: pairs
                .filter((pair) => !replacedIds.has(pair.workItemId))
                .map((pair) => ({ workItemId: pair.workItemId, clarityTaskId: pair.task.taskId })),
            replaced: replaced.map((entry) => ({
                workItemId: entry.pair.workItemId,
                clarityTaskId: entry.pair.task.taskId,
                previousClarityTaskId: entry.previous!.clarityTaskId,
            })),
        })
    );
}

async function runUnlink(options: MappingsOptions): Promise<void> {
    const config = await requireConfig();
    const workItemIds = (options.unlink ?? []).map((raw) => parseWorkItemId(raw, "--unlink"));
    const { mappings, removed } = removeAssignments({ mappings: config.mappings, workItemIds });

    if (removed.length === 0) {
        out.println("No mappings match those work item ids.");
        return;
    }

    if (options.format !== "json") {
        out.println("Will remove:");

        for (const mapping of removed) {
            out.println(`  #${mapping.adoWorkItemId} → ${mapping.clarityTaskName}`);
        }
    }

    if (!options.yes) {
        if (!isInteractive()) {
            out.error("Refusing to remove mappings without --yes in a non-interactive shell");
            process.exit(1);
        }

        const confirmed = await p.confirm({ message: `Remove ${removed.length} mapping(s)?` });

        if (p.isCancel(confirmed) || !confirmed) {
            p.cancel("Cancelled");
            return;
        }
    }

    config.mappings = mappings;
    await saveConfig(config);

    if (options.format === "json") {
        out.result(
            removed.map((m) => ({
                workItemId: m.adoWorkItemId,
                clarityTaskId: m.clarityTaskId,
                clarityTaskName: m.clarityTaskName,
            }))
        );
        return;
    }

    renderReceipt(unlinkReceipt(removed));
}
