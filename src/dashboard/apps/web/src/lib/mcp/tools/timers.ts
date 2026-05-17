import { SafeJSON } from "@dashboard/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, timers } from "@/drizzle";

// Bound to a single owner user; direct DB access scoped to `userId`.
export function registerTimerTools(server: McpServer, userId: string) {
    server.registerTool(
        "list_timers",
        {
            description: "List the owner's timers.",
            inputSchema: {},
        },
        async () => {
            const timerList = db.select().from(timers).where(eq(timers.userId, userId)).all();

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
            description: "Create or update a timer for the owner. Omit id to let the server generate one.",
            inputSchema: {
                id: z.string().optional().describe("Timer ID (omit to create new)"),
                label: z.string().describe("Timer label / name"),
                duration: z.number().optional().describe("Target duration in seconds (for countdown)"),
                mode: z.enum(["stopwatch", "countdown", "pomodoro"]).default("stopwatch"),
            },
        },
        async ({ id: inputId, label, duration, mode }) => {
            const timerId = inputId ?? crypto.randomUUID();
            const now = new Date().toISOString();

            try {
                // Scope updates to the owner: only update a row that is both
                // this id AND owned by userId; insert always carries userId.
                const existing = db
                    .select({ id: timers.id })
                    .from(timers)
                    .where(and(eq(timers.id, timerId), eq(timers.userId, userId)))
                    .get();

                if (existing) {
                    db.update(timers)
                        .set({
                            name: label,
                            timerType: mode,
                            duration: duration ? duration * 1000 : null,
                            updatedAt: now,
                        })
                        .where(and(eq(timers.id, timerId), eq(timers.userId, userId)))
                        .run();
                } else {
                    db.insert(timers)
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
                        .run();
                }

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
            description: "Delete one of the owner's timers by ID.",
            inputSchema: {
                timerId: z.string().describe("Timer ID to delete"),
            },
        },
        async ({ timerId }) => {
            const result = db
                .delete(timers)
                .where(and(eq(timers.id, timerId), eq(timers.userId, userId)))
                .run();

            return {
                content: [
                    {
                        type: "text",
                        text: result.changes > 0 ? `Deleted timer ${timerId}` : `Failed to delete timer ${timerId}`,
                    },
                ],
            };
        }
    );
}
