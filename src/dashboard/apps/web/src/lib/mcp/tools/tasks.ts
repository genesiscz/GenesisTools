import { SafeJSON } from "@dashboard/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { assistantTasks, db } from "@/drizzle";

// Bound to a single owner user (resolved from MCP_USER_ID in the route).
// Queries hit the DB directly, scoped to `userId` — the session-guarded
// server functions cannot be used here (MCP has no browser session).
export function registerTaskTools(server: McpServer, userId: string) {
    server.registerTool(
        "list_tasks",
        {
            description: "List the owner's assistant tasks. Optionally filter by status.",
            inputSchema: {
                status: z
                    .enum(["backlog", "in-progress", "blocked", "completed"])
                    .optional()
                    .describe("Filter by task status"),
                limit: z.number().min(1).max(200).default(50),
            },
        },
        async ({ status, limit }) => {
            const tasks = db
                .select()
                .from(assistantTasks)
                .where(eq(assistantTasks.userId, userId))
                .orderBy(desc(assistantTasks.updatedAt))
                .all();
            const filtered = status ? tasks.filter((t) => t.status === status) : tasks;

            return {
                content: [
                    {
                        type: "text",
                        text: SafeJSON.stringify(filtered.slice(0, limit), null, 2),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "create_task",
        {
            description: "Create a new assistant task for the owner.",
            inputSchema: {
                title: z.string().describe("Task title"),
                description: z.string().optional().describe("Task description"),
                status: z.enum(["backlog", "in-progress", "blocked", "completed"]).default("backlog"),
                urgencyLevel: z.enum(["critical", "important", "nice-to-have"]).default("nice-to-have"),
            },
        },
        async ({ title, description, status, urgencyLevel }) => {
            const now = new Date().toISOString();
            const id = crypto.randomUUID();

            db.insert(assistantTasks)
                .values({
                    id,
                    userId,
                    title,
                    description: description ?? "",
                    status,
                    urgencyLevel,
                    createdAt: now,
                    updatedAt: now,
                    focusTimeLogged: 0,
                    isShippingBlocker: 0,
                })
                .run();

            return {
                content: [{ type: "text", text: `Created task ${id}: ${title}` }],
            };
        }
    );

    server.registerTool(
        "update_task",
        {
            description: "Update one of the owner's assistant tasks.",
            inputSchema: {
                id: z.string().describe("Task ID to update"),
                title: z.string().optional(),
                description: z.string().optional(),
                status: z.enum(["backlog", "in-progress", "blocked", "completed"]).optional(),
                urgencyLevel: z.enum(["critical", "important", "nice-to-have"]).optional(),
            },
        },
        async ({ id, ...patch }) => {
            const result = db
                .update(assistantTasks)
                .set({ ...patch, updatedAt: new Date().toISOString() })
                .where(and(eq(assistantTasks.id, id), eq(assistantTasks.userId, userId)))
                .run();

            if (result.changes === 0) {
                return { content: [{ type: "text", text: `Task ${id} not found.` }] };
            }

            return { content: [{ type: "text", text: `Updated task ${id}` }] };
        }
    );

    server.registerTool(
        "delete_task",
        {
            description: "Delete one of the owner's assistant tasks by ID.",
            inputSchema: {
                id: z.string().describe("Task ID to delete"),
            },
        },
        async ({ id }) => {
            const result = db
                .delete(assistantTasks)
                .where(and(eq(assistantTasks.id, id), eq(assistantTasks.userId, userId)))
                .run();

            return {
                content: [
                    {
                        type: "text",
                        text: result.changes > 0 ? `Deleted task ${id}` : `Failed to delete task ${id}`,
                    },
                ],
            };
        }
    );
}
