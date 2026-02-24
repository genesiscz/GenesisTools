import { printFormatted, truncatePath } from "@app/har-analyzer/core/formatter";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { filterEntries } from "@app/har-analyzer/core/query-engine";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { EntryFilter, HarFile, IndexedEntry, OutputOptions } from "@app/har-analyzer/types";
import type { Command } from "commander";

type SearchScope = "url" | "body" | "header" | "all";

interface SearchOptions {
    scope: SearchScope;
    domain?: string;
    limit: string;
}

interface SearchMatch {
    entry: IndexedEntry;
    context: string;
    scope: string;
}

function extractContext(text: string, query: string, contextLen: number = 60): string | null {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerText.indexOf(lowerQuery);

    if (idx === -1) {
        return null;
    }

    const start = Math.max(0, idx - Math.floor(contextLen / 2));
    const end = Math.min(text.length, idx + query.length + Math.floor(contextLen / 2));

    const prefix = start > 0 ? "..." : "";
    const suffix = end < text.length ? "..." : "";
    const snippet = text.slice(start, end).replace(/\n/g, "\\n");

    return `${prefix}${snippet}${suffix}`;
}

function searchInUrl(entry: IndexedEntry, query: string): string | null {
    return extractContext(entry.url, query);
}

function searchInBody(har: HarFile, entry: IndexedEntry, query: string): string | null {
    const harEntry = har.log.entries[entry.index];
    const responseBody = harEntry.response.content.text ?? "";
    const requestBody = harEntry.request.postData?.text ?? "";
    const combined = responseBody + requestBody;
    if (!combined) {
        return null;
    }
    return extractContext(combined, query);
}

function searchInHeaders(har: HarFile, entry: IndexedEntry, query: string): string | null {
    const harEntry = har.log.entries[entry.index];

    // Search request headers
    for (const h of harEntry.request.headers) {
        const serialized = `${h.name}: ${h.value}`;
        const found = extractContext(serialized, query);
        if (found) {
            return found;
        }
    }

    // Search response headers
    for (const h of harEntry.response.headers) {
        const serialized = `${h.name}: ${h.value}`;
        const found = extractContext(serialized, query);
        if (found) {
            return found;
        }
    }

    return null;
}

export function registerSearchCommand(program: Command): void {
    program
        .command("search <query>")
        .description("Search across entries for a pattern")
        .option("--scope <scope>", "Search scope: url, body, header, all", "all")
        .option("--domain <glob>", "Filter by domain glob pattern")
        .option("--limit <n>", "Maximum results to show", "20")
        .action(async (query: string, options: SearchOptions) => {
            const parentOpts = program.opts<OutputOptions>();
            const sm = new SessionManager();
            const session = await sm.requireSession(parentOpts.session);

            const filter: EntryFilter = {
                domain: options.domain,
            };
            const entries = filterEntries(session.entries, filter);
            const limit = Number(options.limit);
            const scope = options.scope;
            const needsHar = scope === "body" || scope === "header" || scope === "all";

            const har = needsHar ? await loadHarFile(session.sourceFile) : null;
            const matches: SearchMatch[] = [];

            for (const entry of entries) {
                if (matches.length >= limit) {
                    break;
                }

                // URL scope
                if (scope === "url" || scope === "all") {
                    const ctx = searchInUrl(entry, query);
                    if (ctx) {
                        matches.push({ entry, context: ctx, scope: "url" });
                        continue;
                    }
                }

                // Body scope
                if ((scope === "body" || scope === "all") && har) {
                    const ctx = searchInBody(har, entry, query);
                    if (ctx) {
                        matches.push({ entry, context: ctx, scope: "body" });
                        continue;
                    }
                }

                // Header scope
                if ((scope === "header" || scope === "all") && har) {
                    const ctx = searchInHeaders(har, entry, query);
                    if (ctx) {
                        matches.push({ entry, context: ctx, scope: "header" });
                    }
                }
            }

            if (matches.length === 0) {
                console.log(`No matches found for "${query}" in scope "${scope}".`);
                return;
            }

            const lines = matches.map((match) => {
                const e = match.entry;
                const path = truncatePath(e.path, 40);
                return `[e${e.index}] ${e.method} ${path} ${e.status} → ${match.context}`;
            });
            lines.push(`\n${matches.length} matches found`);

            await printFormatted(lines.join("\n"), parentOpts.format);
        });
}
