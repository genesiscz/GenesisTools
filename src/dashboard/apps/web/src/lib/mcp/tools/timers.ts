import { SafeJSON } from "@dashboard/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteTimerFromServer, getTimersFromServer } from "@/lib/timer/timer-sync.server";
import { db, timers } from "@/drizzle";

export function registerTimerTools(server: McpServer) {
    server.registerTool(
        "list_timers",
        {
            description: "List all timers for a user.",
            inputSchema: {
                userId: z.string().describe("The user's WorkOS ID"),
            },
        },
        async ({ userId }) => {
            const timerList = await getTimersFromServer({ data: userId });

            return {
                content: [
                    {
                        type: "text",
                        text: SafeJSON.stringify(timerList, null, 2),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "upsert_timer",
        {
            description:
                "Create or update a timer. Provide the full timer data. Omit id to let the server generate one.",
            inputSchema: {
                userId: z.string().describe("The user's WorkOS ID"),
                id: z.string().optional().describe("Timer ID (omit to create new)"),
                label: z.string().describe("Timer label / name"),
                duration: z.number().optional().describe("Target duration in seconds (for countdown)"),
                mode: z.enum(["stopwatch", "countdown", "pomodoro"]).default("stopwatch"),
            },
        },
        async ({ userId, id: inputId, label, duration, mode }) => {
            const timerId = inputId ?? crypto.randomUUID();
            const now = new Date().toISOString();

            try {
                await db
                    .insert(timers)
                    .values({
                        id: timerId,
                        userId,
                        name: label,
                        timerType: mode,
                        isRunning: 0,
                        elapsedTime: 0,
                        duration: duration ? duration * 1000 : null,
                        laps: [],
                        createdAt: now,
                        updatedAt: now,
                        showTotal: 0,
                    })
                    .onConflictDoUpdate({
                        target: timers.id,
                        set: {
                            name: label,
                            timerType: mode,
                            duration: duration ? duration * 1000 : null,
                            updatedAt: now,
                        },
                    });

                return {
                    content: [{ type: "text", text: `Timer ${timerId} saved.` }],
                };
            } catch (error) {
                console.error("[MCP] upsert_timer error:", error);
                return {
                    content: [{ type: "text", text: "Failed to save timer." }],
                };
            }
        }
    );

    server.registerTool(
        "delete_timer",
        {
            description: "Delete a timer by ID.",
            inputSchema: {
                timerId: z.string().describe("Timer ID to delete"),
                userId: z.string().describe("The user's WorkOS ID"),
            },
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
