import type { IndexedEntry, OutputFormat, SessionStats } from "@app/har-analyzer/types.ts";
import { formatBytes, formatDuration } from "@app/utils/format.ts";
import { formatTable } from "@app/utils/table.ts";

export function truncatePath(path: string, maxLen: number): string {
    if (path.length <= maxLen) {
        return path;
    }
    return `${path.slice(0, maxLen - 3)}...`;
}

export function formatPercent(count: number, total: number): string {
    if (total === 0) {
        return "(0%)";
    }
    const pct = Math.round((count / total) * 100);
    return `(${pct}%)`;
}

export function formatEntryLine(entry: IndexedEntry): string {
    const id = `e${entry.index}`;
    const method = entry.method.padEnd(6);
    const path = truncatePath(entry.path, 40).padEnd(40);
    const status = String(entry.status);
    const size = formatBytes(entry.responseSize).padStart(8);
    const time = formatDuration(entry.timeMs).padStart(8);

    return `${id}  ${method}  ${path}  ${status}  ${size}  ${time}`;
}

export function formatDashboard(stats: SessionStats, sourceFile: string): string {
    const lines: string[] = [];

    // Source file
    lines.push(`Source: ${sourceFile}`);
    lines.push(`Entries: ${stats.entryCount}`);
    lines.push(`Total Duration: ${formatDuration(stats.totalTimeMs)}`);
    lines.push(`Total Size: ${formatBytes(stats.totalSizeBytes)}`);

    // Time range
    if (stats.startTime && stats.endTime) {
        lines.push(`Time Range: ${stats.startTime} - ${stats.endTime}`);
    }

    lines.push("");

    // Status distribution
    lines.push("Status Distribution:");
    const statusBuckets = Object.entries(stats.statusDistribution).sort(([a], [b]) => a.localeCompare(b));
    for (const [bucket, count] of statusBuckets) {
        lines.push(`  ${bucket}: ${count} ${formatPercent(count, stats.entryCount)}`);
    }

    lines.push("");

    // Error count (split client/server)
    const clientErrors = stats.statusDistribution["4xx"] ?? 0;
    const serverErrors = stats.statusDistribution["5xx"] ?? 0;
    lines.push(`Errors: ${stats.errorCount} (client: ${clientErrors}, server: ${serverErrors})`);

    lines.push("");

    // Top domains (sorted by count, show count + size + avg time)
    // We only have count from stats.domains, not size/time breakdowns
    // Show what's available: count per domain
    lines.push("Top Domains:");
    const domainEntries = Object.entries(stats.domains).sort(([, a], [, b]) => b - a);

    const domainHeaders = ["Domain", "Count"];
    const domainRows = domainEntries.map(([domain, count]) => [domain, String(count)]);
    if (domainRows.length > 0) {
        lines.push(formatTable(domainRows, domainHeaders, { alignRight: [1] }));
    }

    lines.push("");

    // Content types (sorted by count)
    lines.push("Content Types:");
    const mimeEntries = Object.entries(stats.mimeTypeDistribution).sort(([, a], [, b]) => b - a);

    const mimeHeaders = ["Type", "Count"];
    const mimeRows = mimeEntries.map(([mime, count]) => [mime, String(count)]);
    if (mimeRows.length > 0) {
        lines.push(formatTable(mimeRows, mimeHeaders, { alignRight: [1] }));
    }

    return lines.join("\n");
}

/**
 * Print text output in the requested format.
 * md: passthrough, json: wrap in {output: text}, toon: encode as TOON.
 */
export async function printFormatted(text: string, format: OutputFormat): Promise<void> {
    switch (format) {
        case "json":
            console.log(JSON.stringify({ output: text }));
            break;
        case "toon": {
            const { encode } = await import("@toon-format/toon");
            console.log(encode({ output: text }));
            break;
        }
        default:
            console.log(text);
    }
}
