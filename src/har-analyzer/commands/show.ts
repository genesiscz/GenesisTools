import { printFormatted } from "@app/har-analyzer/core/formatter";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { parseEntryIndex } from "@app/har-analyzer/core/query-engine";
import { RefStoreManager } from "@app/har-analyzer/core/ref-store";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { HarEntry, HarHeader, OutputOptions } from "@app/har-analyzer/types";
import { isInterestingMimeType } from "@app/har-analyzer/types";
import { formatBytes, formatDuration } from "@app/utils/format";
import { parseJSON } from "@app/utils/json";
import { formatSchema } from "@app/utils/json-schema";
import type { Command } from "commander";

function formatHeaders(headers: HarHeader[]): string {
    return headers.map((h) => `${h.name}: ${h.value}`).join("\n");
}

function formatTimingLine(label: string, value: number | undefined): string | null {
    if (value === undefined || value < 0) return null;
    return `  ${label.padEnd(10)} ${formatDuration(value, "ms", "tiered")}`;
}

type ShowSection = "body" | "headers" | "cookies";

interface ShowOptions {
    raw?: boolean;
    section?: ShowSection;
}

export function registerShowCommand(program: Command): void {
    program
        .command("show <entry>")
        .description("Show entry detail (L2) or full content (L3 with --raw)")
        .option("--raw", "Show full body/headers (L3 detail)")
        .option("--section <section>", "Filter section in raw mode: body, headers, cookies")
        .action(async (entry: string, options: ShowOptions) => {
            const index = parseEntryIndex(entry);
            const parentOpts = program.opts<OutputOptions>();
            const sm = new SessionManager();
            const session = await sm.requireSession(parentOpts.session);

            const indexedEntry = session.entries[index];
            if (!indexedEntry) {
                console.error(
                    `Entry e${index} not found. Session has ${session.entries.length} entries (0-${session.entries.length - 1}).`
                );
                process.exit(1);
            }

            const harFile = await loadHarFile(session.sourceFile);
            const harEntry = harFile.log.entries[index];
            const refStore = new RefStoreManager(session.sourceHash);

            if (options.raw) {
                await showRaw(harEntry, index, refStore, parentOpts, options.section, parentOpts.format);
            } else {
                showDetail(harEntry, indexedEntry.url, parentOpts.format);
            }
        });
}

import type { OutputFormat } from "@app/har-analyzer/types";

async function showDetail(entry: HarEntry, fullUrl: string, format: OutputFormat): Promise<void> {
    const lines: string[] = [];

    // Request line
    lines.push(`${entry.request.method} ${fullUrl}`);
    lines.push(`Status: ${entry.response.status} ${entry.response.statusText}`);
    lines.push("");

    // Timing breakdown
    lines.push("Timing:");
    const timingLabels: Array<[string, number | undefined]> = [
        ["blocked", entry.timings.blocked],
        ["dns", entry.timings.dns],
        ["connect", entry.timings.connect],
        ["ssl", entry.timings.ssl],
        ["send", entry.timings.send],
        ["wait", entry.timings.wait],
        ["receive", entry.timings.receive],
    ];
    for (const [label, value] of timingLabels) {
        const line = formatTimingLine(label, value);
        if (line) lines.push(line);
    }
    lines.push(`  ${"total".padEnd(10)} ${formatDuration(entry.time, "ms", "tiered")}`);
    lines.push("");

    // Request headers summary
    const reqHeaders = entry.request.headers;
    lines.push(`Request Headers: ${reqHeaders.length} total`);
    for (const h of reqHeaders.slice(0, 5)) {
        lines.push(`  ${h.name}: ${h.value}`);
    }
    if (reqHeaders.length > 5) {
        lines.push(`  ... +${reqHeaders.length - 5} more`);
    }
    lines.push("");

    // Response headers summary
    const resHeaders = entry.response.headers;
    lines.push(`Response Headers: ${resHeaders.length} total`);
    for (const h of resHeaders.slice(0, 5)) {
        lines.push(`  ${h.name}: ${h.value}`);
    }
    if (resHeaders.length > 5) {
        lines.push(`  ... +${resHeaders.length - 5} more`);
    }
    lines.push("");

    // Query string params
    if (entry.request.queryString.length > 0) {
        lines.push(`Query Parameters: ${entry.request.queryString.length}`);
        for (const q of entry.request.queryString) {
            lines.push(`  ${q.name}=${q.value}`);
        }
        lines.push("");
    }

    // Request body summary
    if (entry.request.postData) {
        const bodySize =
            entry.request.bodySize >= 0
                ? formatBytes(entry.request.bodySize)
                : entry.request.postData.text?.length != null
                  ? formatBytes(entry.request.postData.text.length)
                  : "unknown";
        lines.push(`Request Body: ${bodySize} (${entry.request.postData.mimeType})`);
    } else {
        lines.push("Request Body: none");
    }

    // Response body summary
    const content = entry.response.content;
    lines.push(`Response Body: ${formatBytes(content.size)} (${content.mimeType})`);

    await printFormatted(lines.join("\n"), format);
}

async function showRaw(
    entry: HarEntry,
    index: number,
    refStore: RefStoreManager,
    parentOpts: OutputOptions,
    section: ShowSection | undefined,
    format: OutputFormat
): Promise<void> {
    const lines: string[] = [];
    const full = parentOpts.full ?? false;
    const includeAll = parentOpts.includeAll ?? false;

    // Request headers
    if (!section || section === "headers") {
        lines.push("=== Request Headers ===");
        const reqHeaderBlock = formatHeaders(entry.request.headers);
        const formatted = await refStore.formatValue(reqHeaderBlock, `e${index}.rq.headers`, { full });
        lines.push(formatted);
        lines.push("");
    }

    // Response headers
    if (!section || section === "headers") {
        lines.push("=== Response Headers ===");
        const resHeaderBlock = formatHeaders(entry.response.headers);
        const formatted = await refStore.formatValue(resHeaderBlock, `e${index}.rs.headers`, { full });
        lines.push(formatted);
        lines.push("");
    }

    // Cookies
    if (section === "cookies") {
        lines.push("=== Request Cookies ===");
        if (entry.request.cookies.length > 0) {
            for (const c of entry.request.cookies) {
                lines.push(`  ${c.name}=${c.value}`);
            }
        } else {
            lines.push("  (none)");
        }
        lines.push("");

        lines.push("=== Response Cookies ===");
        if (entry.response.cookies.length > 0) {
            for (const c of entry.response.cookies) {
                const parts = [`${c.name}=${c.value}`];
                if (c.domain) parts.push(`Domain=${c.domain}`);
                if (c.path) parts.push(`Path=${c.path}`);
                if (c.httpOnly) parts.push("HttpOnly");
                if (c.secure) parts.push("Secure");
                lines.push(`  ${parts.join("; ")}`);
            }
        } else {
            lines.push("  (none)");
        }
        lines.push("");
    }

    // Request body
    if (!section || section === "body") {
        lines.push("=== Request Body ===");
        if (entry.request.postData?.text) {
            const mime = entry.request.postData.mimeType;
            if (isInterestingMimeType(mime) || includeAll) {
                const formatted = await refStore.formatValue(entry.request.postData.text, `e${index}.rq.body`, {
                    full,
                });
                lines.push(formatted);
            } else {
                lines.push(`[skipped: ${mime}, ${formatBytes(entry.request.bodySize)}]`);
            }
        } else {
            lines.push("(none)");
        }
        lines.push("");
    }

    // Response body
    if (!section || section === "body") {
        lines.push("=== Response Body ===");
        const content = entry.response.content;

        if (content.encoding === "base64") {
            lines.push(`[binary: ${content.mimeType}, ${formatBytes(content.size)}]`);
        } else if (content.text) {
            if (isInterestingMimeType(content.mimeType) || includeAll) {
                const formatted = await refStore.formatValue(content.text, `e${index}.rs.body`, { full });
                lines.push(formatted);
            } else {
                lines.push(`[skipped: ${content.mimeType}, ${formatBytes(content.size)}]`);
            }
        } else {
            lines.push("(empty)");
        }
        lines.push("");
    }

    await printFormatted(lines.join("\n"), format);
}

export function registerExpandCommand(program: Command): void {
    program
        .command("expand <refId>")
        .description("Expand a reference to see full content")
        .option("--schema [mode]", "Show schema instead of data (skeleton, typescript, schema)")
        .action(async (refId: string, options: { schema?: string | true }) => {
            // Parse entry index from refId (e.g. "e14.rs.body" -> 14)
            const match = refId.match(/^e(\d+)\./);
            if (!match) {
                console.error(`Invalid refId format: "${refId}". Expected format like "e14.rs.body".`);
                process.exit(1);
            }
            const entryIndex = Number.parseInt(match[1], 10);

            const parentOpts = program.opts<OutputOptions>();
            const sm = new SessionManager();
            const session = await sm.requireSession(parentOpts.session);

            if (entryIndex < 0 || entryIndex >= session.entries.length) {
                console.error(
                    `Entry e${entryIndex} not found. Session has ${session.entries.length} entries (0-${session.entries.length - 1}).`
                );
                process.exit(1);
            }

            const harFile = await loadHarFile(session.sourceFile);
            const harEntry = harFile.log.entries[entryIndex];

            // Parse the path part (everything after "eN.")
            const pathPart = refId.replace(/^e\d+\./, "");
            const content = extractContent(harEntry, pathPart);

            if (content === null) {
                console.error(`No content found for ref "${refId}".`);
                process.exit(1);
            }

            if (options.schema) {
                const parsed = parseJSON(content);
                if (parsed === null) {
                    console.error("Content is not valid JSON. Schema inference requires JSON data.");
                    process.exit(1);
                }
                const mode = options.schema === true ? "skeleton" : options.schema;
                const validModes = ["skeleton", "typescript", "schema"] as const;
                if (!validModes.includes(mode as (typeof validModes)[number])) {
                    console.error(`Invalid schema mode: "${mode}". Use: skeleton, typescript, schema`);
                    process.exit(1);
                }
                await printFormatted(
                    formatSchema(parsed, mode as "skeleton" | "typescript" | "schema"),
                    parentOpts.format
                );
                return;
            }

            await printFormatted(content, parentOpts.format);
        });
}

function extractContent(entry: HarEntry, path: string): string | null {
    switch (path) {
        case "rq.headers":
            return formatHeaders(entry.request.headers);
        case "rs.headers":
            return formatHeaders(entry.response.headers);
        case "rq.body":
            return entry.request.postData?.text ?? null;
        case "rs.body": {
            const content = entry.response.content;
            if (content.encoding === "base64") {
                return `[binary: ${content.mimeType}, ${formatBytes(content.size)}]`;
            }
            return content.text ?? null;
        }
        default:
            return null;
    }
}
