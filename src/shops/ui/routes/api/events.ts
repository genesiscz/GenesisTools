import { sseBroadcaster } from "@app/shops/lib/sse-broadcaster";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/events")({
    server: {
        handlers: {
            GET: async () => {
                const { stream } = sseBroadcaster.subscribe();
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
