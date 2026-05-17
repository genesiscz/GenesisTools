import { SafeJSON } from "@dashboard/shared";
import { createFileRoute } from "@tanstack/react-router";
import { getUserIdFromRequest } from "@/lib/auth/requireUser";
import { subscribeEvents } from "@/lib/events/event-bus.server";

/**
 * Generic SSE bus endpoint. The subscriber is the authenticated session user;
 * `?domain=` is optional (omit to receive every domain). Mirrors the
 * /api/timer-events stream/keepalive/abort lifecycle exactly.
 */
export const Route = createFileRoute("/api/events")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                const url = new URL(request.url);
                const wantDomain = url.searchParams.get("domain");

                const userId = await getUserIdFromRequest(request);
                if (!userId) {
                    return new Response(SafeJSON.stringify({ error: "Unauthorized" }), {
                        status: 401,
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
                                // controller closed during shutdown; expected
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

                        const unsub = subscribeEvents(userId, (event) => {
                            if (wantDomain && event.domain !== wantDomain) {
                                return;
                            }

                            send(event);
                        });

                        request.signal.addEventListener("abort", () => {
                            clearInterval(keepAlive);
                            unsub();
                            try {
                                controller.close();
                            } catch {
                                // already closed; expected
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
