import { createFileRoute } from "@tanstack/react-router";
import { createMcpServer } from "@/lib/mcp/server";
import { handleMcpRequest } from "@/utils/mcp-handler";

const server = createMcpServer();

export const Route = createFileRoute("/mcp")({
    server: {
        handlers: {
            POST: async ({ request }) => handleMcpRequest(request, server),
        },
    },
});
