import { SafeJSON } from "@dashboard/shared";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/events")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                const url = new URL(request.url);
                const userId = url.searchParams.get("userId");

                if (!userId) {
                    return new Response(SafeJSON.stringify({ error: "Missing userId parameter" }), {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                // SSE support has been removed. Cross-tab sync now uses BroadcastChannel API.
                return new Response(SafeJSON.stringify({ error: "SSE endpoint removed. Use BroadcastChannel for cross-tab sync." }), {
                    status: 410,
                    headers: { "Content-Type": "application/json" },
                });
            },
        },
    },
});
