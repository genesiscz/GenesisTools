import { createFileRoute } from "@tanstack/react-router";
import { getEventEmitter } from "@/lib/events/server";

export const Route = createFileRoute("/api/events")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                const url = new URL(request.url);
                const userId = url.searchParams.get("userId");
                const channelsParam = url.searchParams.get("channels");

                // Validate required parameters
                if (!userId) {
                    return new Response(JSON.stringify({ error: "Missing userId parameter" }), {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                // Parse channels (default to common feature channels)
                const channels = channelsParam
                    ? channelsParam
                          .split(",")
                          .map((ch) => ch.trim())
                          .filter(Boolean)
                    : [`timer:${userId}`, `notification:${userId}`];

                console.log(`[SSE] Client connected - userId: ${userId}, channels: ${channels.join(", ")}`);

                const emitter = getEventEmitter();
                const stream = new ReadableStream({
                    start(controller) {
                        const encoder = new TextEncoder();

                        // Send initial connection confirmation
                        const connectionMsg = {
                            type: "connected",
                            userId,
                            channels,
                            timestamp: Date.now(),
                        };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(connectionMsg)}\n\n`));

                        // Create listeners for all requested channels
                        const listeners = new Map<string, (data: unknown) => void>();

                        for (const channel of channels) {
                            const listener = (data: unknown) => {
                                // Format event message
                                const message = {
                                    channel,
                                    data,
                                    timestamp: Date.now(),
                                };

                                // Send event to client
                                try {
                                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
                                } catch (error) {
                                    console.error(`[SSE] Error sending to client:`, error);
                                }
                            };

                            listeners.set(channel, listener);
                            emitter.on(channel, listener);
                            console.log(`[SSE] Subscribed to channel: ${channel}`);
                        }

                        // Send keepalive every 15 seconds (faster connection health checks)
                        const keepaliveInterval = setInterval(() => {
                            try {
                                controller.enqueue(encoder.encode(": keepalive\n\n"));
                            } catch (error) {
                                console.error(`[SSE] Keepalive error:`, error);
                                clearInterval(keepaliveInterval);
                            }
                        }, 15000);

                        // Cleanup on connection close
                        request.signal.addEventListener("abort", () => {
                            console.log(`[SSE] Client disconnected - userId: ${userId}`);

                            // Remove all event listeners
                            for (const [channel, listener] of listeners) {
                                emitter.off(channel, listener);
                                console.log(`[SSE] Unsubscribed from channel: ${channel}`);
                            }

                            // Clear keepalive
                            clearInterval(keepaliveInterval);

                            // Close stream
                            try {
                                controller.close();
                            } catch (_error) {
                                // Stream might already be closed
                            }
                        });
                    },
                });

                // Return SSE response
                return new Response(stream, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache, no-transform",
                        Connection: "keep-alive",
                        "X-Accel-Buffering": "no",
                    },
                });
            },
        },
    },
});
