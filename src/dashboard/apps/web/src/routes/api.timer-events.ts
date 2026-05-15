import { SafeJSON } from "@dashboard/shared";
import { createFileRoute } from "@tanstack/react-router";
import { subscribeTimerEvents } from "@/lib/timer/timer-events.server";

export const Route = createFileRoute("/api/timer-events")({
    server: {
        handlers: {
            GET: ({ request }) => {
                const url = new URL(request.url);
                const userId = url.searchParams.get("userId");

                if (!userId) {
                    return new Response(SafeJSON.stringify({ error: "Missing userId parameter" }), {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                const enc = new TextEncoder();
                const stream = new ReadableStream({
                    start(controller) {
                        const send = (event: unknown) => {
                            try {
                                controller.enqueue(enc.encode(`data: ${SafeJSON.stringify(event)}\n\n`));
                            } catch {
                                // controller may be closed — ignore
                            }
                        };

                        // keep-alive ping every 30s to prevent proxy timeouts
                        const keepAlive = setInterval(() => {
                            try {
                                controller.enqueue(enc.encode(": ping\n\n"));
                            } catch {
                                clearInterval(keepAlive);
                            }
                        }, 30_000);

                        const unsub = subscribeTimerEvents(userId, send);

                        request.signal.addEventListener("abort", () => {
                            clearInterval(keepAlive);
                            unsub();
                            try {
                                controller.close();
                            } catch {
                                // already closed
                            }
                        });
                    },
                });

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
