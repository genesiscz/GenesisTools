import { SafeJSON } from "@dashboard/shared";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    createAssistantTask,
    deleteAssistantTask,
    getAssistantTasks,
    updateAssistantTask,
} from "@/lib/assistant/assistant.server";

export function registerTaskTools(server: McpServer) {
    server.tool(
        "list_tasks",
        {
            description:
                "List assistant tasks for a user. Optionally filter by status.",
            inputSchema: z.object({
                userId: z.string().describe("The user's WorkOS ID"),
                status: z
                    .enum(["backlog", "in-progress", "blocked", "completed"])
                    .optional()
                    .describe("Filter by task status"),
                limit: z.number().min(1).max(200).default(50),
            }),
        },
        async ({ userId, status, limit }) => {
            const tasks = await getAssistantTasks({ data: { userId } });
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

    server.tool(
        "create_task",
        {
            description: "Create a new assistant task for a user.",
            inputSchema: z.object({
                userId: z.string().describe("The user's WorkOS ID"),
                title: z.string().describe("Task title"),
                description: z.string().optional().describe("Task description"),
                status: z
                    .enum(["backlog", "in-progress", "blocked", "completed"])
                    .default("backlog"),
                urgencyLevel: z
                    .enum(["critical", "important", "nice-to-have"])
                    .default("nice-to-have"),
            }),
        },
        async ({ userId, title, description, status, urgencyLevel }) => {
            const now = new Date().toISOString();
            const created = await createAssistantTask({
                data: {
                    id: crypto.randomUUID(),
                    userId,
                    title,
                    description: description ?? "",
                    status,
                    urgencyLevel,
                    createdAt: now,
                    updatedAt: now,
                    focusTimeLogged: 0,
                    isShippingBlocker: 0,
                },
            });

            if (!created) {
                return { content: [{ type: "text", text: "Failed to create task." }] };
            }

            return {
                content: [{ type: "text", text: `Created task ${created.id}: ${created.title}` }],
            };
        }
    );

    server.tool(
        "update_task",
        {
            description: "Update an existing assistant task.",
            inputSchema: z.object({
                id: z.string().describe("Task ID to update"),
                title: z.string().optional(),
                description: z.string().optional(),
                status: z
                    .enum(["backlog", "in-progress", "blocked", "completed"])
                    .optional(),
                urgencyLevel: z
                    .enum(["critical", "important", "nice-to-have"])
                    .optional(),
            }),
        },
        async ({ id, ...patch }) => {
            const updated = await updateAssistantTask({ data: { id, data: patch } });

            if (!updated) {
                return { content: [{ type: "text", text: `Task ${id} not found.` }] };
            }

            return { content: [{ type: "text", text: `Updated task ${id}` }] };
        }
    );

    server.tool(
        "delete_task",
        {
            description: "Delete an assistant task by ID.",
            inputSchema: z.object({
                id: z.string().describe("Task ID to delete"),
            }),
        },
        async ({ id }) => {
            const result = await deleteAssistantTask({ data: { id } });

            return {
                content: [
                    { type: "text", text: result.success ? `Deleted task ${id}` : `Failed to delete task ${id}` },
                ],
            };
        }
    );
}
