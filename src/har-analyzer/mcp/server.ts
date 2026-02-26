import { resolve } from "node:path";
import { formatDashboard, formatEntryLine, truncatePath } from "@app/har-analyzer/core/formatter";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { filterEntries } from "@app/har-analyzer/core/query-engine";
import { RefStoreManager } from "@app/har-analyzer/core/ref-store";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { EntryFilter, HarFile, HarSession } from "@app/har-analyzer/types";
import { isInterestingMimeType } from "@app/har-analyzer/types";
import { formatBytes, formatDuration } from "@app/utils/format";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function startMcpServer(): Promise<void> {
    const sm = new SessionManager();
    let session: HarSession | null = null;
    let harFile: HarFile | null = null;
    let refStore: RefStoreManager | null = null;

    async function ensureSession(): Promise<{ session: HarSession; harFile: HarFile; refStore: RefStoreManager }> {
        if (!session || !harFile || !refStore) {
            session = await sm.loadSession();
            if (!session) {
                throw new Error("No session loaded. Use har_load first.");
            }
            harFile = await loadHarFile(session.sourceFile);
            refStore = new RefStoreManager(session.sourceHash);
        }
        return { session, harFile, refStore };
    }

    const server = new Server({ name: "har-analyzer", version: "1.0.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "har_load",
                description: "Load a HAR file and show the dashboard overview",
                inputSchema: {
                    type: "object" as const,
                    properties: { file: { type: "string", description: "Path to the HAR file" } },
                    required: ["file"],
                },
            },
            {
                name: "har_overview",
                description: "Show dashboard overview of the currently loaded HAR",
                inputSchema: { type: "object" as const, properties: {} },
            },
            {
                name: "har_list",
                description: "List entries with optional filters",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        domain: { type: "string", description: "Filter by domain" },
                        status: { type: "string", description: "Filter by status (e.g. 4xx, 200)" },
                        method: { type: "string", description: "Filter by HTTP method" },
                        url: { type: "string", description: "Filter by URL pattern" },
                        limit: { type: "number", description: "Max entries to show" },
                    },
                },
            },
            {
                name: "har_detail",
                description: "Show detail for a specific entry",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        entry: { type: "number", description: "Entry index" },
                        raw: { type: "boolean", description: "Show full body/headers" },
                        section: { type: "string", description: "Filter section: body, headers, cookies" },
                        full: { type: "boolean", description: "Bypass ref system" },
                    },
                    required: ["entry"],
                },
            },
            {
                name: "har_expand",
                description: "Expand a reference to see full content",
                inputSchema: {
                    type: "object" as const,
                    properties: { ref: { type: "string", description: "Reference ID (e.g. e14.rs.body)" } },
                    required: ["ref"],
                },
            },
            {
                name: "har_search",
                description: "Search across entries",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        query: { type: "string", description: "Search query" },
                        scope: { type: "string", description: "Search scope: url, body, header, all" },
                        domain: { type: "string", description: "Filter by domain" },
                    },
                    required: ["query"],
                },
            },
            {
                name: "har_analyze",
                description: "Run analysis: errors, security",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        type: {
                            type: "string",
                            enum: ["errors", "security"],
                            description: "Analysis type: errors, security",
                        },
                    },
                    required: ["type"],
                },
            },
            {
                name: "har_export",
                description: "Export filtered/sanitized HAR subset",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        domain: { type: "string", description: "Filter by domain" },
                        status: { type: "string", description: "Filter by status" },
                        sanitize: { type: "boolean", description: "Redact sensitive data" },
                        stripBodies: { type: "boolean", description: "Remove body content" },
                    },
                },
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const a = (args ?? {}) as Record<string, unknown>;

        try {
            switch (name) {
                case "har_load": {
                    const filePath = resolve(a.file as string);
                    session = await sm.createSession(filePath);
                    harFile = await loadHarFile(session.sourceFile);
                    refStore = new RefStoreManager(session.sourceHash);
                    sm.cleanExpiredSessions().catch(() => {});
                    return { content: [{ type: "text", text: formatDashboard(session.stats, session.sourceFile) }] };
                }

                case "har_overview": {
                    const ctx = await ensureSession();
                    return {
                        content: [{ type: "text", text: formatDashboard(ctx.session.stats, ctx.session.sourceFile) }],
                    };
                }

                case "har_list": {
                    const ctx = await ensureSession();
                    const filter: EntryFilter = {
                        domain: a.domain as string | undefined,
                        status: a.status as string | undefined,
                        method: a.method as string | undefined,
                        url: a.url as string | undefined,
                        limit: a.limit as number | undefined,
                    };
                    const entries = filterEntries(ctx.session.entries, filter);
                    const lines = entries.map(formatEntryLine);
                    return { content: [{ type: "text", text: lines.join("\n") || "No entries match." }] };
                }

                case "har_detail": {
                    const ctx = await ensureSession();
                    const idx = a.entry as number;
                    if (idx < 0 || idx >= ctx.session.entries.length) {
                        return { content: [{ type: "text", text: `Entry e${idx} not found.` }] };
                    }
                    const entry = ctx.harFile.log.entries[idx];
                    const ie = ctx.session.entries[idx];
                    const full = a.full as boolean | undefined;

                    if (a.raw) {
                        const lines: string[] = [];
                        const section = a.section as string | undefined;

                        if (!section || section === "headers") {
                            lines.push("=== Request Headers ===");
                            const hStr = entry.request.headers.map((h) => `${h.name}: ${h.value}`).join("\n");
                            lines.push(await ctx.refStore.formatValue(hStr, `e${idx}.rq.headers`, { full }));
                            lines.push("\n=== Response Headers ===");
                            const rhStr = entry.response.headers.map((h) => `${h.name}: ${h.value}`).join("\n");
                            lines.push(await ctx.refStore.formatValue(rhStr, `e${idx}.rs.headers`, { full }));
                        }

                        if (!section || section === "body") {
                            lines.push("\n=== Request Body ===");
                            if (entry.request.postData?.text) {
                                lines.push(
                                    await ctx.refStore.formatValue(entry.request.postData.text, `e${idx}.rq.body`, {
                                        full,
                                    })
                                );
                            } else {
                                lines.push("(none)");
                            }

                            lines.push("\n=== Response Body ===");
                            const content = entry.response.content;
                            if (content.encoding === "base64") {
                                lines.push(`[binary: ${content.mimeType}, ${formatBytes(content.size)}]`);
                            } else if (content.text && (isInterestingMimeType(content.mimeType) || full)) {
                                lines.push(await ctx.refStore.formatValue(content.text, `e${idx}.rs.body`, { full }));
                            } else if (content.text) {
                                lines.push(`[skipped: ${content.mimeType}, ${formatBytes(content.size)}]`);
                            } else {
                                lines.push("(empty)");
                            }
                        }

                        return { content: [{ type: "text", text: lines.join("\n") }] };
                    }

                    // L2 detail
                    const lines: string[] = [];
                    lines.push(`${entry.request.method} ${ie.url}`);
                    lines.push(`Status: ${entry.response.status} ${entry.response.statusText}`);
                    lines.push(`Time: ${formatDuration(entry.time)} | Size: ${formatBytes(ie.responseSize)}`);
                    lines.push(
                        `Request Headers: ${entry.request.headers.length} | Response Headers: ${entry.response.headers.length}`
                    );
                    if (entry.request.queryString.length > 0) {
                        lines.push(`Query: ${entry.request.queryString.map((q) => `${q.name}=${q.value}`).join("&")}`);
                    }
                    lines.push(
                        `Request Body: ${entry.request.postData && entry.request.bodySize >= 0 ? formatBytes(entry.request.bodySize) : entry.request.postData ? "unknown" : "none"}`
                    );
                    lines.push(
                        `Response Body: ${formatBytes(entry.response.content.size)} (${entry.response.content.mimeType})`
                    );

                    return { content: [{ type: "text", text: lines.join("\n") }] };
                }

                case "har_expand": {
                    const ctx = await ensureSession();
                    const refId = a.ref as string;
                    const match = refId.match(/^e(\d+)\./);
                    if (!match) {
                        return { content: [{ type: "text", text: `Invalid ref format: "${refId}"` }] };
                    }
                    const entryIdx = Number.parseInt(match[1], 10);
                    if (entryIdx < 0 || entryIdx >= ctx.session.entries.length) {
                        return { content: [{ type: "text", text: `Entry e${entryIdx} not found.` }] };
                    }

                    const entry = ctx.harFile.log.entries[entryIdx];
                    const path = refId.replace(/^e\d+\./, "");

                    let content: string | null = null;
                    switch (path) {
                        case "rq.headers":
                            content = entry.request.headers.map((h) => `${h.name}: ${h.value}`).join("\n");
                            break;
                        case "rs.headers":
                            content = entry.response.headers.map((h) => `${h.name}: ${h.value}`).join("\n");
                            break;
                        case "rq.body":
                            content = entry.request.postData?.text ?? null;
                            break;
                        case "rs.body":
                            content =
                                entry.response.content.encoding === "base64"
                                    ? `[binary: ${entry.response.content.mimeType}, ${formatBytes(entry.response.content.size)}]`
                                    : (entry.response.content.text ?? null);
                            break;
                    }

                    return { content: [{ type: "text", text: content ?? `No content found for ref "${refId}".` }] };
                }

                case "har_search": {
                    const ctx = await ensureSession();
                    const query = (a.query as string).toLowerCase();
                    const scope = (a.scope as string | undefined) ?? "all";
                    const results: string[] = [];

                    for (const ie of ctx.session.entries) {
                        const entry = ctx.harFile.log.entries[ie.index];

                        if (scope === "url" || scope === "all") {
                            if (ie.url.toLowerCase().includes(query)) {
                                results.push(`[e${ie.index}] ${ie.method} ${truncatePath(ie.path, 40)} ${ie.status}`);
                                continue;
                            }
                        }

                        if (scope === "header" || scope === "all") {
                            const allH = [...entry.request.headers, ...entry.response.headers];
                            if (
                                allH.some(
                                    (h) => h.name.toLowerCase().includes(query) || h.value.toLowerCase().includes(query)
                                )
                            ) {
                                results.push(
                                    `[e${ie.index}] ${ie.method} ${truncatePath(ie.path, 40)} ${ie.status} (header match)`
                                );
                                continue;
                            }
                        }

                        if (scope === "body" || scope === "all") {
                            const body = (entry.response.content.text ?? "") + (entry.request.postData?.text ?? "");
                            if (body.toLowerCase().includes(query)) {
                                results.push(
                                    `[e${ie.index}] ${ie.method} ${truncatePath(ie.path, 40)} ${ie.status} (body match)`
                                );
                            }
                        }
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: results.length > 0 ? results.join("\n") : `No matches for "${a.query}".`,
                            },
                        ],
                    };
                }

                case "har_analyze": {
                    const ctx = await ensureSession();
                    const type = a.type as string;

                    if (type === "errors") {
                        const errors = ctx.session.entries.filter((e) => e.isError);
                        if (errors.length === 0) {
                            return { content: [{ type: "text", text: "No errors found." }] };
                        }
                        const lines = errors.map((e) => {
                            const raw = ctx.harFile.log.entries[e.index];
                            const body = raw.response.content.text?.slice(0, 80) ?? "";
                            return `e${e.index}  ${e.status}  ${e.method}  ${truncatePath(e.path, 40)}  ${formatDuration(e.timeMs)}${body ? `\n  ${body}` : ""}`;
                        });
                        return { content: [{ type: "text", text: lines.join("\n") }] };
                    }

                    if (type === "security") {
                        const findings: string[] = [];
                        for (const ie of ctx.session.entries) {
                            const raw = ctx.harFile.log.entries[ie.index];
                            for (const h of raw.request.headers) {
                                if (h.name.toLowerCase() === "authorization" && h.value.startsWith("Bearer ey")) {
                                    findings.push(`[e${ie.index}] JWT in Authorization`);
                                }
                            }
                            for (const q of raw.request.queryString) {
                                if (/^(api_?key|token|secret|key)$/i.test(q.name)) {
                                    findings.push(`[e${ie.index}] ${q.name} in query string`);
                                }
                            }
                        }
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: findings.length > 0 ? findings.join("\n") : "No security findings.",
                                },
                            ],
                        };
                    }

                    return {
                        content: [
                            { type: "text", text: `Unknown analysis type: ${type}. Supported: errors, security` },
                        ],
                    };
                }

                case "har_export": {
                    const ctx = await ensureSession();
                    const filter: EntryFilter = {
                        domain: a.domain as string | undefined,
                        status: a.status as string | undefined,
                    };
                    const filtered = filterEntries(ctx.session.entries, filter);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Would export ${filtered.length} entries. Use CLI: tools har-analyzer export [--domain X] [--sanitize] [-o file]`,
                            },
                        ],
                    };
                }

                default:
                    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
