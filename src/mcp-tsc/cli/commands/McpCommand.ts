import path from "path";
import type { CliArgs } from "@app/mcp-tsc/core/interfaces.js";
import { LspServer } from "@app/mcp-tsc/providers/LspServer.js";
import { McpAdapter } from "@app/mcp-tsc/protocols/McpAdapter.js";
import logger from "@app/logger";

export class McpCommand {
    async execute(argv: CliArgs): Promise<void> {
        logger.debug(
            { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
            "McpCommand.execute() called"
        );

        // Use --root flag, fallback to first positional argument, then current directory
        const rootDir = argv.root || argv._[0] || process.cwd();
        const cwd = path.resolve(rootDir);
        const timeout = argv.timeout ?? 30;

        logger.info(
            {
                component: "mcp-tsc",
                subcomponent: "McpCommand",
                pid: process.pid,
                cwd,
                timeout,
            },
            "MCP Server configuration"
        );
        console.error(`Starting TypeScript Diagnostics MCP Server (root: ${cwd}, timeout: ${timeout}s)`);

        // MCP always uses LSP
        logger.debug(
            { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
            "Creating LspServer instance"
        );
        const lspServer = new LspServer({ cwd, debug: true });
        logger.debug(
            { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
            "LspServer instance created"
        );

        logger.debug(
            { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
            "Creating McpAdapter instance"
        );
        const mcpAdapter = new McpAdapter({ server: lspServer, cwd, timeout });
        logger.debug(
            { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
            "McpAdapter instance created"
        );

        // Cleanup handlers
        let sigintHandled = false;
        let sigtermHandled = false;

        process.on("SIGINT", async () => {
            if (sigintHandled) {
                logger.warn(
                    { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
                    "SIGINT handler called again (already handled)"
                );
                return;
            }
            sigintHandled = true;
            logger.warn(
                { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
                "SIGINT received, shutting down MCP adapter"
            );
            try {
                await mcpAdapter.shutdown();
                logger.info(
                    { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
                    "MCP adapter shutdown complete, exiting with code 0"
                );
            } catch (error) {
                logger.error(
                    {
                        component: "mcp-tsc",
                        subcomponent: "McpCommand",
                        pid: process.pid,
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined,
                    },
                    "Error during MCP adapter shutdown"
                );
            }
            process.exit(0);
        });

        process.on("SIGTERM", async () => {
            if (sigtermHandled) {
                logger.warn(
                    { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
                    "SIGTERM handler called again (already handled)"
                );
                return;
            }
            sigtermHandled = true;
            logger.warn(
                { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
                "SIGTERM received, shutting down MCP adapter"
            );
            try {
                await mcpAdapter.shutdown();
                logger.info(
                    { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
                    "MCP adapter shutdown complete, exiting with code 0"
                );
            } catch (error) {
                logger.error(
                    {
                        component: "mcp-tsc",
                        subcomponent: "McpCommand",
                        pid: process.pid,
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined,
                    },
                    "Error during MCP adapter shutdown"
                );
            }
            process.exit(0);
        });

        logger.debug(
            { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
            "Signal handlers registered, calling mcpAdapter.start()"
        );
        try {
            await mcpAdapter.start();
            logger.warn(
                { component: "mcp-tsc", subcomponent: "McpCommand", pid: process.pid },
                "mcpAdapter.start() completed (this should not happen - MCP server should run indefinitely)"
            );
        } catch (error) {
            logger.error(
                {
                    component: "mcp-tsc",
                    subcomponent: "McpCommand",
                    pid: process.pid,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                },
                "mcpAdapter.start() threw error"
            );
            throw error;
        }
    }
}
