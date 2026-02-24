#!/usr/bin/env node

import logger from "@app/logger";
import { CliHandler } from "@app/mcp-tsc/cli/CliHandler.js";
import { DiagnosticsCommand } from "@app/mcp-tsc/cli/commands/DiagnosticsCommand.js";
import { HoverCommand } from "@app/mcp-tsc/cli/commands/HoverCommand.js";
import { KillServerCommand } from "@app/mcp-tsc/cli/commands/KillServerCommand.js";
import { McpCommand } from "@app/mcp-tsc/cli/commands/McpCommand.js";
import type { TSServer } from "@app/mcp-tsc/core/interfaces.js";
import { getPersistentServer } from "@app/mcp-tsc/utils/ServerManager.js";
import { handleReadmeFlag } from "@app/utils/readme";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

// Track if we've already set up diagnostic handlers
let diagnosticHandlersSetup = false;

function setupDiagnosticHandlers(): void {
    if (diagnosticHandlersSetup) {
        logger.warn(
            { component: "mcp-tsc", pid: process.pid },
            "Diagnostic handlers already set up, skipping duplicate setup"
        );
        return;
    }
    diagnosticHandlersSetup = true;

    // Log process startup
    logger.info(
        {
            component: "mcp-tsc",
            pid: process.pid,
            ppid: process.ppid,
            cwd: process.cwd(),
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            command: process.argv.join(" "),
        },
        "Process started"
    );

    // Track process exit
    process.on("exit", (code) => {
        logger.info({ component: "mcp-tsc", pid: process.pid, exitCode: code }, "Process exiting");
    });

    // Track uncaught exceptions
    process.on("uncaughtException", (error) => {
        logger.error(
            {
                component: "mcp-tsc",
                pid: process.pid,
                error: error.message,
                stack: error.stack,
            },
            "Uncaught exception"
        );
    });

    // Track unhandled promise rejections
    process.on("unhandledRejection", (reason) => {
        const errorInfo =
            reason instanceof Error ? { error: reason.message, stack: reason.stack } : { reason: String(reason) };
        logger.error(
            {
                component: "mcp-tsc",
                pid: process.pid,
                ...errorInfo,
            },
            "Unhandled promise rejection"
        );
    });

    // Track all signals that could terminate the process
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"];

    for (const signal of signals) {
        process.on(signal, () => {
            logger.warn(
                { component: "mcp-tsc", pid: process.pid, signal },
                "Received signal - process may be terminated"
            );
        });
    }

    // Track if process is being killed externally
    const originalKill = process.kill.bind(process);
    (process as any).kill = (pid?: number | NodeJS.Signals, signal?: NodeJS.Signals): boolean => {
        logger.warn({ component: "mcp-tsc", pid: process.pid, targetPid: pid, signal }, "process.kill() called");
        if (pid !== undefined && signal !== undefined) {
            return originalKill(pid as any, signal as any);
        } else if (pid !== undefined) {
            return originalKill(pid as any);
        } else {
            return originalKill(process.pid);
        }
    };

    // Monitor for process disconnection (parent process died)
    process.on("disconnect", () => {
        logger.warn(
            { component: "mcp-tsc", pid: process.pid },
            "Process disconnected from parent (parent may have died)"
        );
    });

    // Monitor for warnings
    process.on("warning", (warning) => {
        logger.warn(
            {
                component: "mcp-tsc",
                pid: process.pid,
                warningName: warning.name,
                warningMessage: warning.message,
                stack: warning.stack,
            },
            "Process warning"
        );
    });
}

// Set up diagnostic handlers immediately
setupDiagnosticHandlers();

async function main() {
    logger.debug({ component: "mcp-tsc", pid: process.pid }, "main() function called");

    const cliHandler = new CliHandler();
    const argv = cliHandler.parseArgs();

    if (argv.help) {
        cliHandler.showHelp();
        process.exit(0);
    }

    const command = cliHandler.determineCommand(argv);
    const cwd = process.cwd();

    logger.info({ component: "mcp-tsc", pid: process.pid, command, cwd }, "Executing command");

    switch (command) {
        case "kill-server":
            {
                logger.debug({ component: "mcp-tsc", pid: process.pid }, "Executing kill-server command");
                const killCommand = new KillServerCommand(cwd);
                await killCommand.execute(argv);
            }
            break;

        case "mcp":
            {
                logger.info(
                    { component: "mcp-tsc", pid: process.pid, args: argv },
                    "Executing mcp command - starting MCP server"
                );
                const mcpCommand = new McpCommand();
                logger.debug(
                    { component: "mcp-tsc", pid: process.pid },
                    "McpCommand instance created, calling execute()"
                );
                await mcpCommand.execute(argv);
                logger.debug({ component: "mcp-tsc", pid: process.pid }, "McpCommand.execute() completed");
            }
            break;

        case "diagnostics":
            {
                if (argv._.length === 0) {
                    console.error("Error: No files specified for diagnostics");
                    cliHandler.showHelp();
                    process.exit(1);
                }

                logger.info(
                    { component: "mcp-tsc", pid: process.pid, fileCount: argv._.length },
                    "Executing diagnostics command"
                );

                // For diagnostics, use persistent server if LSP mode, or create TSC server
                let tsServer: TSServer;
                if (argv["use-tsc"]) {
                    logger.info({ component: "mcp-tsc", pid: process.pid }, "Using TSC server (--use-tsc flag)");
                    tsServer = cliHandler.createTsServer(argv, cwd);
                } else {
                    // Use persistent LSP server
                    logger.debug({ component: "mcp-tsc", pid: process.pid, cwd }, "Retrieving persistent LSP server");
                    tsServer = await getPersistentServer(cwd, process.env.DEBUG === "1");
                    logger.debug({ component: "mcp-tsc", pid: process.pid }, "Persistent LSP server retrieved");
                }

                const diagCommand = new DiagnosticsCommand(tsServer, cwd);
                await diagCommand.execute(argv);
                logger.debug({ component: "mcp-tsc", pid: process.pid }, "Diagnostics command completed");
            }
            break;

        case "hover":
            {
                if (argv["use-tsc"]) {
                    console.error("Error: Hover is not supported with --use-tsc. Use LSP mode (default) for hover.");
                    process.exit(1);
                }

                logger.info({ component: "mcp-tsc", pid: process.pid }, "Executing hover command");

                // Hover always uses persistent LSP server
                logger.debug(
                    { component: "mcp-tsc", pid: process.pid, cwd },
                    "Retrieving persistent LSP server for hover"
                );
                const tsServer = await getPersistentServer(cwd, process.env.DEBUG === "1");
                logger.debug({ component: "mcp-tsc", pid: process.pid }, "Persistent LSP server retrieved for hover");

                const hoverCommand = new HoverCommand(tsServer, cwd);
                await hoverCommand.execute(argv);
                logger.debug({ component: "mcp-tsc", pid: process.pid }, "Hover command completed");
            }
            break;
    }

    logger.debug({ component: "mcp-tsc", pid: process.pid }, "main() function completed");
}

main().catch((err) => {
    logger.error(
        {
            component: "mcp-tsc",
            pid: process.pid,
            error: err.message,
            stack: err.stack,
        },
        "main() caught error"
    );
    console.error(`\nError: ${err.message}`);
    if (process.env.DEBUG === "1") {
        console.error(err.stack);
    }
    logger.info({ component: "mcp-tsc", pid: process.pid, exitCode: 2 }, "Exiting due to error");
    process.exit(2);
});
