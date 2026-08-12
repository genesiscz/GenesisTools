import { resolve } from "node:path";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { filterEntries } from "@app/har-analyzer/core/query-engine";
import { redactEntry } from "@app/har-analyzer/core/redactor";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { EntryFilter, HarEntry, HarFile, OutputOptions } from "@app/har-analyzer/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

function sanitizeEntry(entry: HarEntry, index: number): HarEntry {
    return redactEntry(entry, index).entry;
}

function stripBodies(entry: HarEntry): HarEntry {
    const clone = SafeJSON.parse(SafeJSON.stringify(entry)) as HarEntry;

    if (clone.request.postData) {
        clone.request.postData.text = undefined;
        clone.request.postData.params = undefined;
    }

    clone.response.content.text = undefined;

    return clone;
}

export function registerExportCommand(program: Command): void {
    program
        .command("export")
        .description("Export filtered/sanitized HAR subset")
        .option("--domain <domain>", "Filter by domain")
        .option("--status <status>", "Filter by status (e.g. 4xx, 200)")
        .option("--method <method>", "Filter by HTTP method")
        .option("--sanitize", "Redact sensitive headers, cookies, API keys")
        .option("--strip-bodies", "Remove request/response body content")
        .option("-o, --output <file>", "Output file path (default: stdout)")
        .action(
            async (options: {
                domain?: string;
                status?: string;
                method?: string;
                sanitize?: boolean;
                stripBodies?: boolean;
                output?: string;
            }) => {
                const parentOpts = program.opts<OutputOptions>();
                const sm = new SessionManager();
                const session = await sm.requireSession(parentOpts.session);

                const harFile = await loadHarFile(session.sourceFile);

                // Apply filters
                const filter: EntryFilter = {
                    domain: options.domain,
                    status: options.status,
                    method: options.method,
                };

                const filtered = filterEntries(session.entries, filter);
                const filteredIndices = new Set(filtered.map((e) => e.index));

                // Build filtered HAR
                let entries = harFile.log.entries.filter((_, i) => filteredIndices.has(i));

                // Apply transformations
                if (options.sanitize) {
                    entries = entries.map((entry, i) => sanitizeEntry(entry, i));
                }
                if (options.stripBodies) {
                    entries = entries.map(stripBodies);
                }

                const exportedHar: HarFile = {
                    log: {
                        ...harFile.log,
                        entries,
                    },
                };

                const json = SafeJSON.stringify(exportedHar, null, 2);

                if (options.output) {
                    const outPath = resolve(options.output);
                    await Bun.write(outPath, json);
                    out.println(`Exported ${entries.length} entries to ${outPath}`);
                } else {
                    out.println(json);
                }
            }
        );
}
