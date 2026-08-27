/**
 * Azure DevOps CLI - Sprint / iteration commands.
 *
 * `iterations` lists the project's sprints. `sprint` lists the work items of one
 * of them, with the effort columns the ADO Backlog tab shows.
 *
 * `--team` is optional. Iterations are project-level classification nodes and a
 * team only subscribes to a subset of them, so a team narrows the list without
 * ever changing which work items come back. With no team these commands read
 * the project's classification nodes instead of failing.
 *
 * The queries never use `@CurrentIteration`. That macro needs a team context,
 * fails with `VS402612` when none is available, and hides which iteration the
 * server picked even when it works. We resolve the iteration ourselves and put
 * an explicit `[System.IterationPath]` predicate in the WIQL instead.
 */

import { Api } from "@app/azure-devops/api";
import type { TeamIteration } from "@app/azure-devops/api.types";
import {
    describeIterationSource,
    findCurrentIteration,
    type IterationSource,
    iterationContainsDate,
    resolveIteration,
} from "@app/azure-devops/lib/iterations";
import {
    buildSprintWiql,
    mapSprintRow,
    SPRINT_FIELDS,
    type SprintRow,
    sortByBacklogOrder,
    sortById,
    sumTaskEffort,
} from "@app/azure-devops/lib/sprint";
import { resolveTeam } from "@app/azure-devops/lib/team";
import type { AzureConfig, OutputFormat } from "@app/azure-devops/types";
import { requireConfig } from "@app/azure-devops/utils";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, renderCliSection, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

// ============= Options =============

interface IterationsOptions {
    format: OutputFormat;
    team?: string;
}

interface SprintOptions {
    format: OutputFormat;
    team?: string;
    mine?: boolean;
    assignedTo?: string;
    totals?: boolean;
    order?: boolean;
}

// ============= Shared helpers =============

function parseFormat(raw: string | undefined): OutputFormat {
    const value = (raw ?? "ai").toLowerCase();

    if (value === "ai" || value === "md" || value === "json") {
        return value;
    }

    out.error(`Unknown --format "${raw}". Use one of: ai, md, json.`);
    process.exit(1);
}

/** The team narrows the iteration list when it is set. Absent is normal, not an error. */
function optionalTeam(config: AzureConfig, explicit?: string): string | null {
    const resolved = resolveTeam(config, explicit);

    if (!resolved) {
        logger.debug("[sprint] No team set; reading the project's iteration classification nodes");
        return null;
    }

    logger.debug(`[sprint] Using team "${resolved.team}" (source: ${resolved.source})`);
    return resolved.team;
}

/**
 * Team-subscribed iterations when a team is known, the project's classification
 * nodes otherwise. The source travels with the list so the row-count difference
 * between the two is never a silent surprise.
 */
async function loadIterations(
    api: Api,
    team: string | null
): Promise<{ iterations: TeamIteration[]; source: IterationSource }> {
    if (team) {
        const iterations = await api.getTeamIterations(team);
        return { iterations, source: { kind: "team", team, count: iterations.length } };
    }

    const iterations = await api.getProjectIterations();
    return { iterations, source: { kind: "project", team: null, count: iterations.length } };
}

function formatDate(iso: string | null | undefined): string {
    if (!iso) {
        return "-";
    }

    return iso.slice(0, 10);
}

/** Hours render as integers when they are whole, so "8" does not print as "8.00". */
function formatEffort(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** A literal pipe would break the markdown row. */
function escapeMd(value: string): string {
    return value.replace(/\|/g, "\\|");
}

function mdRow(cells: string[]): string {
    return `| ${cells.join(" | ")} |`;
}

// ============= iterations =============

async function handleIterations(options: IterationsOptions): Promise<void> {
    const config = requireConfig();
    const team = optionalTeam(config, options.team);
    const api = new Api(config);
    const { iterations, source } = await loadIterations(api, team);
    const sourceLabel = describeIterationSource(source);

    if (iterations.length === 0) {
        out.error(`No iterations found: ${sourceLabel}.`);
        process.exit(1);
    }

    const now = new Date();
    const current = findCurrentIteration(iterations, now);

    if (options.format === "json") {
        out.result(
            SafeJSON.stringify(
                {
                    source: { ...source, label: sourceLabel },
                    iterations: iterations.map((it) => ({
                        id: it.id,
                        name: it.name,
                        path: it.path,
                        startDate: it.attributes?.startDate ?? null,
                        finishDate: it.attributes?.finishDate ?? null,
                        isCurrent: iterationContainsDate(it, now),
                    })),
                },
                null,
                2
            )
        );
        return;
    }

    if (options.format === "md") {
        const lines = [
            "# Iterations",
            "",
            `Source: ${escapeMd(sourceLabel)}`,
            "",
            mdRow(["Current", "Name", "Path", "Start", "Finish"]),
            mdRow(["---", "---", "---", "---", "---"]),
            ...iterations.map((it) =>
                mdRow([
                    iterationContainsDate(it, now) ? "**now**" : "",
                    escapeMd(it.name),
                    `\`${escapeMd(it.path)}\``,
                    formatDate(it.attributes?.startDate),
                    formatDate(it.attributes?.finishDate),
                ])
            ),
        ];
        out.result(`${lines.join("\n")}\n`);
        return;
    }

    renderCliHeader("Iterations", sourceLabel);
    const table = createBoxTable(["", "NAME", "PATH", "START", "FINISH"]);

    for (const it of iterations) {
        const isCurrent = iterationContainsDate(it, now);
        const name = truncateDisplay(it.name, 44);
        table.push([
            isCurrent ? pc.green("*") : " ",
            isCurrent ? pc.green(name) : name,
            pc.dim(truncateDisplay(it.path, 46)),
            formatDate(it.attributes?.startDate),
            formatDate(it.attributes?.finishDate),
        ]);
    }

    out.println(table.toString());
    renderCliSection("Current");
    out.println(
        current
            ? `  * ${current.name}  (${formatDate(current.attributes?.startDate)} -> ${formatDate(current.attributes?.finishDate)})`
            : "  none: no iteration's date range contains today"
    );
    out.println(pc.dim("\nNext: tools azure-devops sprint --mine --totals"));
}

// ============= sprint =============

/** Print every candidate and exit non-zero rather than guessing. */
function exitAmbiguous(query: string, candidates: TeamIteration[]): never {
    out.error(`"${query}" matches ${candidates.length} iterations. Narrow it down:`);

    for (const candidate of candidates) {
        out.printlnErr(`  ${candidate.name}   (${candidate.path})`);
    }

    process.exit(1);
}

async function resolveSprintIteration(
    api: Api,
    team: string | null,
    nameOrPath: string | undefined
): Promise<{ iteration: TeamIteration; source: IterationSource }> {
    const { iterations, source } = await loadIterations(api, team);
    const sourceLabel = describeIterationSource(source);
    const resolution = resolveIteration(iterations, nameOrPath, new Date());

    if (resolution.kind === "resolved") {
        logger.debug(`[sprint] Resolved iteration "${resolution.iteration.path}" by ${resolution.matchedBy}`);
        return { iteration: resolution.iteration, source };
    }

    if (resolution.kind === "ambiguous") {
        exitAmbiguous(nameOrPath ?? "", resolution.candidates);
    }

    if (resolution.kind === "no-current") {
        out.error(
            `No iteration in ${sourceLabel} contains today. Name one explicitly, for example: tools azure-devops sprint "Sprint 17"`
        );
        process.exit(1);
    }

    out.error(
        `No iteration in ${sourceLabel} matches "${resolution.query}". List them with: tools azure-devops iterations`
    );
    process.exit(1);
}

async function fetchSprintRows(
    api: Api,
    iteration: TeamIteration,
    assignedTo: string | undefined
): Promise<SprintRow[]> {
    const wiql = buildSprintWiql({ iterationPath: iteration.path, assignedTo });
    logger.debug(`[sprint] WIQL: ${wiql}`);

    const result = await api.runWiql(wiql);
    const ids = (result.workItems ?? []).map((wi) => wi.id);
    logger.debug(`[sprint] WIQL returned ${ids.length} work item ids`);

    if (ids.length === 0) {
        return [];
    }

    const fieldsById = await api.getWorkItemFields(ids, SPRINT_FIELDS);
    return ids.map((id) => mapSprintRow(id, fieldsById.get(id) ?? {}));
}

function toJsonItems(rows: SprintRow[]): Array<Record<string, unknown>> {
    return rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        state: row.state,
        assignedTo: row.assignedTo,
        completedWork: row.completedWork,
        remainingWork: row.remainingWork,
        order: row.order,
        changedDate: row.changedDate,
    }));
}

/** Both renderers take the same four, and the two trailing values are unreadable positionally. */
interface SprintRenderArgs {
    rows: SprintRow[];
    iteration: TeamIteration;
    withOrder: boolean;
    sourceLabel: string;
}

function renderSprintMd({ rows, iteration, withOrder }: SprintRenderArgs): string {
    const header = ["ID", "Type", "Title", "State", "AssignedTo", "CompletedWork", "RemainingWork"];

    if (withOrder) {
        header.push("Order");
    }

    header.push("ChangedDate");

    const body = rows.map((row) => {
        const cells = [
            String(row.id),
            escapeMd(row.type),
            escapeMd(row.title),
            escapeMd(row.state),
            escapeMd(row.assignedTo),
            formatEffort(row.completedWork),
            formatEffort(row.remainingWork),
        ];

        if (withOrder) {
            cells.push(row.order === null ? "-" : String(row.order));
        }

        cells.push(formatDate(row.changedDate));
        return mdRow(cells);
    });

    return [
        `# ${escapeMd(iteration.name)}`,
        "",
        `Iteration path: \`${iteration.path}\``,
        `Source: ${escapeMd(sourceLabel)}`,
        "",
        mdRow(header),
        mdRow(header.map(() => "---")),
        ...body,
    ].join("\n");
}

function renderSprintTable({ rows, iteration, withOrder, sourceLabel }: SprintRenderArgs): void {
    renderCliHeader(iteration.name, `${iteration.path}  ·  source: ${sourceLabel}`);

    const headers = ["ID", "TYPE", "TITLE", "STATE", "ASSIGNED", "DONE", "LEFT"];

    if (withOrder) {
        headers.push("ORDER");
    }

    const table = createBoxTable(headers);

    for (const row of rows) {
        const remaining = formatEffort(row.remainingWork);
        const cells = [
            pc.cyan(String(row.id)),
            truncateDisplay(row.type, 12),
            truncateDisplay(row.title, 52),
            truncateDisplay(row.state, 18),
            truncateDisplay(row.assignedTo, 20),
            formatEffort(row.completedWork),
            row.remainingWork > 0 ? pc.yellow(remaining) : remaining,
        ];

        if (withOrder) {
            cells.push(row.order === null ? pc.dim("-") : String(row.order));
        }

        table.push(cells);
    }

    out.println(table.toString());
}

async function handleSprint(nameOrPath: string | undefined, options: SprintOptions): Promise<void> {
    if (options.mine && options.assignedTo) {
        out.error("--mine and --assigned-to are mutually exclusive.");
        process.exit(1);
    }

    const config = requireConfig();
    const team = optionalTeam(config, options.team);
    const assignedTo = options.mine ? "@Me" : options.assignedTo;
    const api = new Api(config);
    const { iteration, source } = await resolveSprintIteration(api, team, nameOrPath);
    const sourceLabel = describeIterationSource(source);
    const fetched = await fetchSprintRows(api, iteration, assignedTo);
    const withOrder = options.order ?? false;
    const rows = withOrder ? sortByBacklogOrder(fetched) : sortById(fetched);
    const totals = sumTaskEffort(rows);

    if (options.format === "json") {
        const payload = {
            iteration: { name: iteration.name, path: iteration.path },
            source: { ...source, label: sourceLabel },
            items: toJsonItems(rows),
            ...(options.totals
                ? {
                      totals: {
                          itemCount: totals.itemCount,
                          taskCount: totals.taskCount,
                          taskCompletedWork: totals.completedWork,
                          taskRemainingWork: totals.remainingWork,
                      },
                  }
                : {}),
        };
        out.result(SafeJSON.stringify(payload, null, 2));
        return;
    }

    const totalsLines = [
        `Items: ${totals.itemCount} (Tasks: ${totals.taskCount})`,
        `Task CompletedWork: ${formatEffort(totals.completedWork)} h`,
        `Task RemainingWork: ${formatEffort(totals.remainingWork)} h`,
        "Non-Task rows are excluded, so a User Story and its child Task are not counted twice.",
    ];

    if (options.format === "md") {
        const md = renderSprintMd({ rows, iteration, withOrder, sourceLabel });
        const withTotals = options.totals
            ? `${md}\n\n## Totals\n\n${totalsLines.map((line) => `- ${line}`).join("\n")}`
            : md;
        out.result(`${withTotals}\n`);
        return;
    }

    renderSprintTable({ rows, iteration, withOrder, sourceLabel });

    if (options.totals) {
        renderCliSection("Totals");

        for (const line of totalsLines) {
            out.println(`  ${line}`);
        }
    }
}

// ============= Registration =============

interface RawSprintOptions {
    format?: string;
    team?: string;
    mine?: boolean;
    assignedTo?: string;
    totals?: boolean;
    order?: boolean;
}

/**
 * Merge the subcommand's own options with the program-level `--team`.
 * `optsWithGlobals()` cannot be used: it lets the parent's undefined `team`
 * overwrite a value passed after the subcommand.
 */
function optionsWithGlobalTeam(command: Command): RawSprintOptions {
    const local = command.opts<RawSprintOptions>();
    const globals = command.parent?.opts<{ team?: string }>() ?? {};
    return { ...local, team: local.team ?? globals.team };
}

export function registerSprintCommands(program: Command): void {
    program
        .command("iterations")
        .alias("sprints")
        .description("List the team's iterations (sprints) with dates and the current one marked")
        .option("-f, --format <format>", "Output format: ai, md, json", "ai")
        .option("--team <name>", "Optional: narrow to one team's subscribed iterations (overrides config.team)")
        .action(async (_opts: RawSprintOptions, command: Command) => {
            const opts = optionsWithGlobalTeam(command);
            await handleIterations({ format: parseFormat(opts.format), team: opts.team });
        });

    program
        .command("sprint [nameOrPath]")
        .description("List the work items of one iteration (defaults to the iteration containing today)")
        .option("-f, --format <format>", "Output format: ai, md, json", "ai")
        .option("--team <name>", "Optional: narrow to one team's subscribed iterations (overrides config.team)")
        .option("--mine", "Only work items assigned to me (@Me)")
        .option("--assigned-to <name>", "Only work items assigned to this display name or unique name")
        .option("--totals", "Print the Task-only CompletedWork / RemainingWork sums")
        .option("--order", "Sort by Backlog stack rank instead of id, and show the Order column")
        .action(async (nameOrPath: string | undefined, _opts: RawSprintOptions, command: Command) => {
            const opts = optionsWithGlobalTeam(command);
            await handleSprint(nameOrPath, {
                format: parseFormat(opts.format),
                team: opts.team,
                mine: opts.mine,
                assignedTo: opts.assignedTo,
                totals: opts.totals,
                order: opts.order,
            });
        });
}
