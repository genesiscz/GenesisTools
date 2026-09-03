import { formatCost, formatTokens } from "@genesiscz/utils/format";
import { createBoxTable } from "@genesiscz/utils/table";
import type { SessionBlock } from "./blocks";
import type { PeriodGrain } from "./types";

function asRows(report: Record<string, unknown>, key: string): Record<string, unknown>[] {
    const value = report[key];
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelsCell(row: Record<string, unknown>): string {
    if (Array.isArray(row.modelsUsed)) {
        return (row.modelsUsed as string[]).join(", ");
    }

    if (row.models && typeof row.models === "object" && !Array.isArray(row.models)) {
        return Object.keys(row.models as Record<string, unknown>).join(", ");
    }

    if (Array.isArray(row.models)) {
        return (row.models as string[]).join(", ");
    }

    return "";
}

function periodCell(row: Record<string, unknown>): string {
    return String(row.period ?? row.date ?? row.week ?? row.month ?? row.sessionId ?? "");
}

function costCell(row: Record<string, unknown>): string {
    if (typeof row.totalCost === "number") {
        return formatCost(row.totalCost);
    }

    if (typeof row.costUSD === "number") {
        return formatCost(row.costUSD);
    }

    return formatCost(0);
}

export function renderPeriodTable(report: Record<string, unknown>, grain: PeriodGrain, breakdown: boolean): string {
    const rows = asRows(report, grain);
    const header = grain === "weekly" ? "WEEK" : grain === "monthly" ? "MONTH" : "DATE";
    const table = createBoxTable([
        header,
        "MODELS",
        "INPUT",
        "OUTPUT",
        "CACHE CREATE",
        "CACHE READ",
        "TOTAL TOKENS",
        "COST",
    ]);

    for (const row of rows) {
        table.push([
            periodCell(row),
            modelsCell(row),
            formatTokens(num(row.inputTokens)),
            formatTokens(num(row.outputTokens)),
            formatTokens(num(row.cacheCreationTokens)),
            formatTokens(num(row.cacheReadTokens)),
            formatTokens(num(row.totalTokens)),
            costCell(row),
        ]);

        if (breakdown && Array.isArray(row.modelBreakdowns)) {
            for (const model of row.modelBreakdowns as Record<string, unknown>[]) {
                table.push([
                    "",
                    String(model.modelName ?? ""),
                    formatTokens(num(model.inputTokens)),
                    formatTokens(num(model.outputTokens)),
                    formatTokens(num(model.cacheCreationTokens)),
                    formatTokens(num(model.cacheReadTokens)),
                    formatTokens(
                        num(model.inputTokens) +
                            num(model.outputTokens) +
                            num(model.cacheCreationTokens) +
                            num(model.cacheReadTokens)
                    ),
                    formatCost(num(model.cost)),
                ]);
            }
        }
    }

    const totals = (report.totals ?? {}) as Record<string, unknown>;
    table.push([
        "Total",
        "",
        formatTokens(num(totals.inputTokens)),
        formatTokens(num(totals.outputTokens)),
        formatTokens(num(totals.cacheCreationTokens)),
        formatTokens(num(totals.cacheReadTokens)),
        formatTokens(num(totals.totalTokens)),
        typeof totals.totalCost === "number" ? formatCost(totals.totalCost) : formatCost(num(totals.costUSD)),
    ]);

    return table.toString();
}

export function renderSessionTable(report: Record<string, unknown>, breakdown: boolean): string {
    const rows = asRows(report, "session").length > 0 ? asRows(report, "session") : asRows(report, "sessions");
    const table = createBoxTable([
        "SESSION",
        "MODELS",
        "INPUT",
        "OUTPUT",
        "CACHE CREATE",
        "CACHE READ",
        "TOTAL TOKENS",
        "COST",
    ]);

    for (const row of rows) {
        table.push([
            periodCell(row).slice(0, 36),
            modelsCell(row),
            formatTokens(num(row.inputTokens)),
            formatTokens(num(row.outputTokens)),
            formatTokens(num(row.cacheCreationTokens)),
            formatTokens(num(row.cacheReadTokens)),
            formatTokens(num(row.totalTokens)),
            costCell(row),
        ]);

        if (breakdown && Array.isArray(row.modelBreakdowns)) {
            for (const model of row.modelBreakdowns as Record<string, unknown>[]) {
                table.push([
                    "",
                    String(model.modelName ?? ""),
                    formatTokens(num(model.inputTokens)),
                    formatTokens(num(model.outputTokens)),
                    formatTokens(num(model.cacheCreationTokens)),
                    formatTokens(num(model.cacheReadTokens)),
                    formatTokens(
                        num(model.inputTokens) +
                            num(model.outputTokens) +
                            num(model.cacheCreationTokens) +
                            num(model.cacheReadTokens)
                    ),
                    formatCost(num(model.cost)),
                ]);
            }
        }
    }

    return table.toString();
}

export function renderBlocksTable(report: { blocks: SessionBlock[] }, breakdown: boolean): string {
    const table = createBoxTable([
        "BLOCK",
        "MODELS",
        "INPUT",
        "OUTPUT",
        "CACHE CREATE",
        "CACHE READ",
        "TOTAL TOKENS",
        "COST",
    ]);

    for (const block of report.blocks) {
        const tokens = (block.tokenCounts ?? {}) as Record<string, unknown>;
        const models = Array.isArray(block.models) ? (block.models as string[]).join(", ") : "";
        table.push([
            block.isGap
                ? `gap ${String(block.startTime ?? "").slice(0, 16)}`
                : String(block.startTime ?? "").slice(0, 19),
            models,
            formatTokens(num(tokens.inputTokens)),
            formatTokens(num(tokens.outputTokens)),
            formatTokens(num(tokens.cacheCreationInputTokens)),
            formatTokens(num(tokens.cacheReadInputTokens)),
            formatTokens(num(block.totalTokens)),
            formatCost(num(block.costUSD)),
        ]);

        if (breakdown) {
            for (const model of block.modelBreakdowns) {
                table.push([
                    "",
                    model.modelName,
                    formatTokens(model.inputTokens),
                    formatTokens(model.outputTokens),
                    formatTokens(model.cacheCreationTokens),
                    formatTokens(model.cacheReadTokens),
                    formatTokens(
                        model.inputTokens + model.outputTokens + model.cacheCreationTokens + model.cacheReadTokens
                    ),
                    formatCost(model.cost),
                ]);
            }
        }
    }

    return table.toString();
}
