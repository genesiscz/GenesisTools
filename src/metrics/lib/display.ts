import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    type DimValue,
    type MetricCatalogEntry,
    type MetricCheckpoint,
    type MetricEventRow,
    type MetricEventsResult,
    type MetricQueryResult,
    RATE_AGGREGATES,
} from "@genesiscz/utils/metrics/types";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

function number(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return pc.dim("-");
    }

    return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2);
}

function groupCell(name: string, value: DimValue): string {
    if (name.startsWith("time:") && typeof value === "number") {
        return formatLocalDateTimeStamp(value, { seconds: false });
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
    // Grouped by checkpoint alone: each span and the per-day rates, since the spans differ in length.
    const spans = result.rows.some((row) => row.span);
    const rates = spans ? RATE_AGGREGATES.filter((name) => result.aggregates.includes(name)) : [];
    const table = createBoxTable([
        ...result.groupBy,
        ...(spans ? ["from", "to", "days"] : []),
        ...result.aggregates,
        ...rates.map((name) => `${name}/day`),
    ]);

    for (const row of result.rows) {
        table.push([
            ...result.groupBy.map((name) => groupCell(name, row.group[name] ?? null)),
            ...(spans
                ? [
                      row.span ? formatLocalDateTimeStamp(row.span.from, { seconds: false }) : "",
                      row.span ? formatLocalDateTimeStamp(row.span.to, { seconds: false }) : "",
                      row.span ? row.span.days.toFixed(2) : "",
                  ]
                : []),
            ...result.aggregates.map((aggregate) => number(row.values[aggregate])),
            ...rates.map((name) => number(row.perDay?.[name])),
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

export function eventLine(row: {
    at: number;
    value: number;
    dims: Record<string, DimValue>;
    context?: unknown;
    checkpoint?: string;
}) {
    const checkpoint = row.checkpoint === undefined ? "" : `${pc.cyan(`[${row.checkpoint}]`)}  `;
    return `${pc.dim(formatLocalDateTimeStamp(row.at))}  ${pc.white(number(row.value).padStart(8))}  ${checkpoint}${dimsText(row.dims)}`;
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
            entry.first ? formatLocalDateTimeStamp(entry.first, { seconds: false }) : "",
            entry.last ? formatLocalDateTimeStamp(entry.last, { seconds: false }) : "",
            entry.dims.join(", "),
        ]);
    }

    out.println(table.toString());
}

export function printCheckpoints(checkpoints: readonly MetricCheckpoint[], note: string): void {
    renderCliHeader("Checkpoints", note);
    const table = createBoxTable(["PROJECT", "NAME", "AT", "COMMIT", "REPO", "NOTE"]);

    for (const checkpoint of checkpoints) {
        table.push([
            checkpoint.project,
            pc.white(checkpoint.name),
            formatLocalDateTimeStamp(checkpoint.at, { seconds: false }),
            checkpoint.commit ? truncateDisplay(checkpoint.commit, 12) : "",
            checkpoint.repo ? truncateDisplay(checkpoint.repo, 30) : "",
            checkpoint.note ? truncateDisplay(checkpoint.note, 50) : "",
        ]);
    }

    out.println(table.toString());
}
