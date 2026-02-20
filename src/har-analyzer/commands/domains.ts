import { printFormatted, truncatePath } from "@app/har-analyzer/core/formatter";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { filterEntries, groupByDomain } from "@app/har-analyzer/core/query-engine";
import { RefStoreManager } from "@app/har-analyzer/core/ref-store";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { EntryFilter, OutputOptions } from "@app/har-analyzer/types";
import { isInterestingMimeType } from "@app/har-analyzer/types";
import { formatBytes, formatDuration } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";

export function registerDomainsCommand(program: Command): void {
    program
        .command("domains")
        .description("List all domains sorted by request count")
        .action(async () => {
            const parentOpts = program.opts<OutputOptions>();
            const sm = new SessionManager();
            const session = await sm.requireSession(parentOpts.session);

            const groups = groupByDomain(session.entries);

            const domainStats: Array<{
                domain: string;
                count: number;
                totalSize: number;
                avgTime: number;
            }> = [];

            for (const [domain, entries] of groups) {
                const totalSize = entries.reduce((sum, e) => sum + e.responseSize, 0);
                const totalTime = entries.reduce((sum, e) => sum + e.timeMs, 0);
                domainStats.push({
                    domain,
                    count: entries.length,
                    totalSize,
                    avgTime: entries.length > 0 ? totalTime / entries.length : 0,
                });
            }

            domainStats.sort((a, b) => b.count - a.count);

            const headers = ["Domain", "Count", "Total Size", "Avg Time"];
            const rows = domainStats.map((d) => [
                d.domain,
                String(d.count),
                formatBytes(d.totalSize),
                formatDuration(d.avgTime),
            ]);

            const output = `${formatTable(rows, headers, { alignRight: [1, 2, 3] })}\n\n${domainStats.length} domains`;
            await printFormatted(output, parentOpts.format);
        });
}

interface DomainOptions {
    status?: string;
    method?: string;
    limit?: string;
    includeAll?: boolean;
}

export function registerDomainCommand(program: Command): void {
    program
        .command("domain <name>")
        .description("Show entries for a specific domain")
        .option("--status <codes>", "Filter by status codes (e.g. 200, 4xx, !3xx)")
        .option("--method <methods>", "Filter by HTTP methods (comma-separated)")
        .option("--limit <n>", "Maximum entries to show")
        .option("--include-all", "Include bodies of static assets (CSS, JS, images, fonts)")
        .action(async (name: string, options: DomainOptions) => {
            const parentOpts = program.opts<OutputOptions>();

            const sm = new SessionManager();
            const session = await sm.requireSession(parentOpts.session);

            const filter: EntryFilter = {
                domain: name,
                status: options.status,
                method: options.method,
                limit: options.limit ? Number(options.limit) : undefined,
            };

            const entries = filterEntries(session.entries, filter);

            if (entries.length === 0) {
                console.log(`No entries found for domain "${name}".`);
                return;
            }

            const har = await loadHarFile(session.sourceFile);
            const refStore = new RefStoreManager(session.sourceHash);
            const includeAll = options.includeAll ?? parentOpts.includeAll;

            const headers = ["#", "Method", "Path", "Status", "Body Preview"];
            const rows: string[][] = [];

            for (const entry of entries) {
                const harEntry = har.log.entries[entry.index];
                const bodyText = harEntry.response.content.text;

                let bodyPreview: string;
                if (!bodyText || bodyText.length === 0) {
                    bodyPreview = "(empty)";
                } else if (!includeAll && !isInterestingMimeType(entry.mimeType)) {
                    bodyPreview = `(${entry.mimeType})`;
                } else {
                    bodyPreview = await refStore.formatValue(bodyText, `e${entry.index}.rs.body`, {
                        full: parentOpts.full,
                    });
                }

                rows.push([
                    `e${entry.index}`,
                    entry.method,
                    truncatePath(entry.path, 50),
                    String(entry.status),
                    bodyPreview,
                ]);
            }

            const output = `${formatTable(rows, headers)}\n\n${entries.length} entries for ${name}`;
            await printFormatted(output, parentOpts.format);
        });
}
