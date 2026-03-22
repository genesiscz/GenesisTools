#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { shutdownManager } from "./mcp/shared";
import { registerGraphTools } from "./mcp/tools/graph";
import { registerIndexTools } from "./mcp/tools/index";
import { registerManageTools } from "./mcp/tools/manage";
import { registerModelsTools } from "./mcp/tools/models";
import { registerSearchTools } from "./mcp/tools/search";

const server = new McpServer(
    {
        name: "genesis-indexer",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Register all tool groups
registerSearchTools(server);
registerIndexTools(server);
registerManageTools(server);
registerGraphTools(server);
registerModelsTools(server);

// ── Start server ─────────────────────────────────────────────
async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // ── Process-level error handlers ─────────────────────────
    process.on("unhandledRejection", (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        console.error(`Unhandled rejection: ${msg}`);
    });

    // ── Graceful shutdown ────────────────────────────────────
    let shuttingDown = false;

    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        console.error(`Shutting down (${signal})...`);
        await shutdownManager();
        await server.close();
        process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.stdin.on("end", () => shutdown("stdin EOF"));
    process.stdin.on("close", () => shutdown("stdin close"));
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
