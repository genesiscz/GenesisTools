import { printFormatted } from "@app/har-analyzer/core/formatter";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { IndexedEntry, OutputOptions } from "@app/har-analyzer/types";
import { formatBytes } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";

interface MimeBucket {
    mime: string;
    count: number;
    totalSize: number;
}

function buildMimeBuckets(entries: IndexedEntry[]): MimeBucket[] {
    const map = new Map<string, MimeBucket>();

    for (const entry of entries) {
        const mime = entry.mimeType || "unknown";
        const existing = map.get(mime);
        if (existing) {
            existing.count++;
            existing.totalSize += entry.responseSize;
        } else {
            map.set(mime, { mime, count: 1, totalSize: entry.responseSize });
        }
    }

    return [...map.values()].sort((a, b) => b.totalSize - a.totalSize);
}

function makeBar(value: number, max: number, width = 20): string {
    if (max === 0) return "";
    const filled = Math.round((value / max) * width);
    return "\u2588".repeat(filled);
}

export function registerSizeCommand(program: Command): void {
    program
        .command("size")
        .description("Bandwidth breakdown by content type")
        .action(async () => {
            const parentOpts = program.opts<OutputOptions>();
            const sm = new SessionManager();
            const session = await sm.requireSession(parentOpts.session);

            const entries = session.entries;
            const totalSize = entries.reduce((sum, e) => sum + e.responseSize, 0);

            const lines: string[] = [];
            lines.push(`Total: ${formatBytes(totalSize)} across ${entries.length} entries`);
            lines.push("");

            // By content type
            const buckets = buildMimeBuckets(entries);
            lines.push("By Content Type:");

            const maxSize = buckets[0]?.totalSize ?? 0;
            const mimeHeaders = ["Type", "Count", "Size", "%", ""];
            const mimeRows = buckets.map((b) => {
                const pct = totalSize > 0 ? Math.round((b.totalSize / totalSize) * 100) : 0;
                return [b.mime, String(b.count), formatBytes(b.totalSize), `${pct}%`, makeBar(b.totalSize, maxSize)];
            });

            lines.push(formatTable(mimeRows, mimeHeaders, { alignRight: [1, 2, 3] }));
            lines.push("");

            // Largest responses
            lines.push("Largest Responses:");
            const sorted = [...entries].sort((a, b) => b.responseSize - a.responseSize);
            const top = sorted.slice(0, 10);

            const topHeaders = ["#", "Path", "Size", "Type"];
            const topRows = top.map((e) => {
                const path = e.path.length > 40 ? `${e.path.slice(0, 37)}...` : e.path;
                return [`e${e.index}`, path, formatBytes(e.responseSize), e.mimeType];
            });

            lines.push(formatTable(topRows, topHeaders, { alignRight: [2] }));

            await printFormatted(lines.join("\n"), parentOpts.format);
        });
}
