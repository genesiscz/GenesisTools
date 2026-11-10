import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type {
    DimValue,
    MetricCatalogEntry,
    MetricEventRow,
    MetricEventsResult,
    MetricQueryResult,
} from "@genesiscz/utils/metrics/types";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

/** Local time, minute or second precision: `2026-11-11 09:30`. */
export function localTime(at: number, seconds = false): string {
    const date = new Date(at);
    const pad = (value: number) => String(value).padStart(2, "0");
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ""}`;

    return `${day} ${clock}`;
}

function number(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return pc.dim("-");
    }

    return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2);
}

function groupCell(name: string, value: DimValue): string {
    if (name.startsWith("time:") && typeof value === "number") {
        return localTime(value);
    }

    return value === null ? pc.dim("null") : String(value);
}

function dimsText(dims: Record<string, DimValue>): string {
    return Object.entries(dims)
        .map(([name, value]) => `${name}=${value === null ? "null" : String(value)}`)
        .join(" ");
}

export function printQuery(result: MetricQueryResult): void {
    if (!result.known) {
        out.printlnErr(`No events for ${result.project} / ${result.metric} yet.`);
        return;
    }

    renderCliHeader(`${result.project} / ${result.metric}`, `${result.rows.length} rows · ${result.ms.toFixed(1)} ms`);
    const table = createBoxTable([...result.groupBy, ...result.aggregates]);

    for (const row of result.rows) {
        table.push([
            ...result.groupBy.map((name) => groupCell(name, row.group[name] ?? null)),
            ...result.aggregates.map((aggregate) => number(row.values[aggregate])),
        ]);
    }

    out.println(table.toString());
}

function contextText(row: MetricEventRow): string {
    if (row.context === undefined) {
        return "";
    }

    const text = typeof row.context === "string" ? row.context : SafeJSON.stringify(row.context, { strict: true });
    return truncateDisplay(text.replace(/\s+/g, " "), 80);
}

export function eventLine(row: { at: number; value: number; dims: Record<string, DimValue>; context?: unknown }) {
    return `${pc.dim(localTime(row.at, true))}  ${pc.white(number(row.value).padStart(8))}  ${dimsText(row.dims)}`;
}

export function printEvents(result: MetricEventsResult): void {
    if (!result.known) {
        out.printlnErr(`No events for ${result.project} / ${result.metric} yet.`);
        return;
    }

    renderCliHeader(`${result.project} / ${result.metric}`, `${result.rows.length} newest events`);

    for (const row of result.rows) {
        out.println(eventLine(row));
        const context = contextText(row);

        if (context) {
            out.println(`    ${pc.dim(context)}`);
        }
    }
}

export function printCatalog(entries: readonly MetricCatalogEntry[], note: string): void {
    renderCliHeader("Metrics", note);
    const table = createBoxTable(["PROJECT", "METRIC", "UNIT", "EVENTS", "FIRST", "LAST", "INDEXED DIMS"]);

    for (const entry of entries) {
        table.push([
            entry.project,
            pc.white(entry.metric),
            entry.unit ?? "",
            number(entry.count),
            entry.first ? localTime(entry.first) : "",
            entry.last ? localTime(entry.last) : "",
            entry.dims.join(", "),
        ]);
    }

    out.println(table.toString());
}
