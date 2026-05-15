import { SafeJSON } from "@dashboard/shared";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    deleteTimerFromServer,
    getTimersFromServer,
    uploadSyncBatch,
} from "@/lib/timer/timer-sync.server";

export function registerTimerTools(server: McpServer) {
    server.tool(
        "list_timers",
        {
            description: "List all timers for a user.",
            inputSchema: z.object({
                userId: z.string().describe("The user's WorkOS ID"),
            }),
        },
        async ({ userId }) => {
            const timers = await getTimersFromServer({ data: userId });

            return {
                content: [
                    {
                        type: "text",
                        text: SafeJSON.stringify(timers, null, 2),
                    },
                ],
            };
        }
    );

    server.tool(
        "upsert_timer",
        {
            description:
                "Create or update a timer. Provide the full timer data. Omit id to let the server generate one.",
            inputSchema: z.object({
                userId: z.string().describe("The user's WorkOS ID"),
                id: z.string().optional().describe("Timer ID (omit to create new)"),
                label: z.string().describe("Timer label / name"),
                duration: z.number().optional().describe("Target duration in seconds (for countdown)"),
                mode: z.enum(["stopwatch", "countdown", "pomodoro"]).default("stopwatch"),
            }),
        },
        async ({ userId, id: inputId, label, duration, mode }) => {
            const timerId = inputId ?? crypto.randomUUID();
            const now = new Date().toISOString();

            const result = await uploadSyncBatch({
                data: {
                    operations: [
                        {
                            id: timerId,
                            op: "PUT",
                            table: "timers",
                            data: {
                                id: timerId,
                                user_id: userId,
                                label,
                                duration: duration ?? null,
                                mode,
                                status: "idle",
                                elapsed: 0,
                                created_at: now,
                                updated_at: now,
                            },
                        },
                    ],
                },
            });

            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? `Timer ${timerId} saved.` : "Failed to save timer.",
                    },
                ],
            };
        }
    );

    server.tool(
        "delete_timer",
        {
            description: "Delete a timer by ID.",
            inputSchema: z.object({
                timerId: z.string().describe("Timer ID to delete"),
                userId: z.string().describe("The user's WorkOS ID"),
            }),
        },
        async ({ timerId, userId }) => {
            const result = await deleteTimerFromServer({ data: { timerId, userId } });

            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? `Deleted timer ${timerId}` : `Failed to delete timer ${timerId}`,
                    },
                ],
            };
        }
    );
}
