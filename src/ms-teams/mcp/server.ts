import { openCache } from "@app/ms-teams/lib/cache";
import { inspectDoctor } from "@app/ms-teams/lib/doctor";
import { exportThread } from "@app/ms-teams/lib/export/thread";
import { ingestIndexedDb } from "@app/ms-teams/lib/ingest";
import { materializeThreadMedia } from "@app/ms-teams/lib/media";
import { parseQueryDate, parseShowQuery } from "@app/ms-teams/lib/query";
import { resolveConversation } from "@app/ms-teams/lib/resolve-chat";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type CallToolResult, type ListToolsResult, Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const log = logger.scoped("ms-teams").log;

type Handler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export function createHandlers(): Record<string, Handler> {
    return {
        ms_teams_sync: async () => ingestIndexedDb({ force: true }),
        ms_teams_doctor: () => inspectDoctor(),
        ms_teams_conversations: (args) => {
            const cache = openCache();

            try {
                return cache.listConversations({
                    withName: str(args.with),
                    topic: str(args.topic),
                    limit: typeof args.limit === "number" ? args.limit : 40,
                });
            } finally {
                cache.close();
            }
        },
        ms_teams_show: async (args) => {
            const cache = openCache();

            try {
                const query = parseShowQuery(str(args.query) ?? "");
                query.id = str(args.id) ?? query.id;
                query.withName = str(args.with) ?? query.withName;
                query.from = str(args.from) ? parseQueryDate(String(args.from), "start") : query.from;
                query.to = str(args.to) ? parseQueryDate(String(args.to), "end") : query.to;
                const resolved = resolveConversation(cache, query);

                if (resolved.status !== "exact") {
                    return resolved;
                }

                const thread = exportThread(cache, resolved.conversation.id, { from: query.from, to: query.to });
                return materializeThreadMedia(thread);
            } finally {
                cache.close();
            }
        },
        ms_teams_search: (args) => {
            const text = str(args.text);

            if (!text) {
                throw new Error("ms_teams_search requires a non-empty 'text' argument");
            }

            const cache = openCache();

            try {
                return cache.searchMessages(text, {
                    withName: str(args.with),
                    from: str(args.from) ? parseQueryDate(String(args.from), "start") : undefined,
                    to: str(args.to) ? parseQueryDate(String(args.to), "end") : undefined,
                });
            } finally {
                cache.close();
            }
        },
        ms_teams_people: (args) => {
            const cache = openCache();

            try {
                return cache.listPeople(str(args.query));
            } finally {
                cache.close();
            }
        },
        ms_teams_files: (args) => {
            const cache = openCache();

            try {
                return cache.listFiles(str(args.id));
            } finally {
                cache.close();
            }
        },
    };
}

export async function startMcpServer(): Promise<void> {
    const handlers = createHandlers();
    const server = new Server({ name: "ms-teams", version: "1.0.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: [
                {
                    name: "ms_teams_sync",
                    description: "Snapshot and ingest the local Teams IndexedDB cache",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "ms_teams_doctor",
                    description: "Read-only Teams path and cache diagnosis",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "ms_teams_conversations",
                    description: "List cached Teams conversations",
                    inputSchema: {
                        type: "object",
                        properties: { with: { type: "string" }, topic: { type: "string" }, limit: { type: "number" } },
                    },
                },
                {
                    name: "ms_teams_show",
                    description: "Resolve a conversation by name/topic/id and return its messages",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: { type: "string" },
                            id: { type: "string" },
                            with: { type: "string" },
                            from: { type: "string" },
                            to: { type: "string" },
                        },
                    },
                },
                {
                    name: "ms_teams_search",
                    description: "Full-text search over cached Teams messages",
                    inputSchema: {
                        type: "object",
                        properties: {
                            text: { type: "string" },
                            with: { type: "string" },
                            from: { type: "string" },
                            to: { type: "string" },
                        },
                        required: ["text"],
                    },
                },
                {
                    name: "ms_teams_people",
                    description: "Search cached Teams people",
                    inputSchema: { type: "object", properties: { query: { type: "string" } } },
                },
                {
                    name: "ms_teams_files",
                    description: "List cached attachments",
                    inputSchema: { type: "object", properties: { id: { type: "string" } } },
                },
            ],
        })
    );

    server.setRequestHandler("tools/call", async (req): Promise<CallToolResult> => {
        const handler = handlers[req.params.name];

        if (!handler) {
            return { content: [{ type: "text", text: `Unknown tool ${req.params.name}` }], isError: true };
        }

        try {
            const args = (req.params.arguments ?? {}) as Record<string, unknown>;
            const result = await handler(args);
            return { content: [{ type: "text", text: SafeJSON.stringify(result, null, 2) }] };
        } catch (err) {
            log.debug({ err }, "[ms-teams] mcp tool failed");
            return {
                content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
                isError: true,
            };
        }
    });

    await server.connect(new StdioServerTransport());
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
