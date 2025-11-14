#!/usr/bin/env node

import { CliHandler } from "./cli/CliHandler.js";
import { DiagnosticsCommand } from "./cli/commands/DiagnosticsCommand.js";
import { HoverCommand } from "./cli/commands/HoverCommand.js";
import { KillServerCommand } from "./cli/commands/KillServerCommand.js";
import { McpCommand } from "./cli/commands/McpCommand.js";
import { getPersistentServer } from "./utils/ServerManager.js";

async function main() {
    const cliHandler = new CliHandler();
    const argv = cliHandler.parseArgs();

    if (argv.help) {
        cliHandler.showHelp();
        process.exit(0);
    }

    const command = cliHandler.determineCommand(argv);
    const cwd = process.cwd();

    switch (command) {
        case "kill-server":
            {
                const killCommand = new KillServerCommand(cwd);
                await killCommand.execute(argv);
            }
            break;

        case "mcp":
            {
                const mcpCommand = new McpCommand();
                await mcpCommand.execute(argv);
            }
            break;

        case "diagnostics":
            {
                if (argv._.length === 0) {
                    console.error("Error: No files specified for diagnostics");
                    cliHandler.showHelp();
                    process.exit(1);
                }

                // For diagnostics, use persistent server if LSP mode, or create TSC server
                let tsServer;
                if (argv["use-tsc"]) {
                    tsServer = cliHandler.createTsServer(argv, cwd);
                } else {
                    // Use persistent LSP server
                    tsServer = await getPersistentServer(cwd, process.env.DEBUG === "1");
                }

                const diagCommand = new DiagnosticsCommand(tsServer, cwd);
                await diagCommand.execute(argv);
            }
            break;

        case "hover":
            {
                if (argv["use-tsc"]) {
                    console.error("Error: Hover is not supported with --use-tsc. Use LSP mode (default) for hover.");
                    process.exit(1);
                }

                // Hover always uses persistent LSP server
                const tsServer = await getPersistentServer(cwd, process.env.DEBUG === "1");
                const hoverCommand = new HoverCommand(tsServer, cwd);
                await hoverCommand.execute(argv);
            }
            break;
    }
}

main().catch((err) => {
    console.error(`\nError: ${err.message}`);
    if (process.env.DEBUG === "1") {
        console.error(err.stack);
    }
    process.exit(2);
});
