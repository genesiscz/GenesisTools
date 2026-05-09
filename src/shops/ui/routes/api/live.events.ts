import { createFileRoute } from "@tanstack/react-router";
import { ensureLiveEventPoller, getInitialLiveEvents } from "../../../lib/live-events-source";
import { sseBroadcaster } from "../../../lib/sse-broadcaster";

export const Route = createFileRoute("/api/live/events")({
    server: {
        handlers: {
            GET: async () => {
                ensureLiveEventPoller();
                const initialEvents = await getInitialLiveEvents();
                const { stream } = sseBroadcaster.subscribe({ initialEvents });
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
