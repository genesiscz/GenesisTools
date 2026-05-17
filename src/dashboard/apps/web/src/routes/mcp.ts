import { SafeJSON } from "@dashboard/shared";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "@/lib/env";
import { createMcpServer } from "@/lib/mcp/server";
import { handleMcpRequest } from "@/utils/mcp-handler";

// MCP has no browser session. It is disabled unless BOTH a bearer token and
// the owner user id are configured; when enabled, every tool is bound to that
// single user (no cross-user access, no userId tool argument).
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }

    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return mismatch === 0;
}

export const Route = createFileRoute("/mcp")({
    server: {
        handlers: {
            POST: async ({ request }) => {
                const token = env.MCP_BEARER_TOKEN;
                const ownerUserId = env.MCP_USER_ID;

                if (!token || !ownerUserId) {
                    return new Response(SafeJSON.stringify({ error: "MCP endpoint is not configured" }), {
                        status: 501,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                const authz = request.headers.get("authorization") ?? "";
                const presented = authz.startsWith("Bearer ") ? authz.slice(7) : "";

                if (!presented || !timingSafeEqual(presented, token)) {
                    return new Response(SafeJSON.stringify({ error: "Unauthorized" }), {
                        status: 401,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                return handleMcpRequest(request, createMcpServer(ownerUserId));
            },
        },
    },
});
