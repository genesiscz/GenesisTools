import path from "path";
import type { CliArgs } from "../../core/interfaces.js";
import { LspServer } from "../../providers/LspServer.js";
import { McpAdapter } from "../../protocols/McpAdapter.js";

export class McpCommand {
    async execute(argv: CliArgs): Promise<void> {
        // Use --root flag, fallback to first positional argument, then current directory
        const rootDir = argv.root || argv._[0] || process.cwd();
        const cwd = path.resolve(rootDir);

        console.error(`Starting TypeScript Diagnostics MCP Server (root: ${cwd})`);

        // MCP always uses LSP
        const lspServer = new LspServer({ cwd, debug: true });
        const mcpAdapter = new McpAdapter({ server: lspServer, cwd });

        // Cleanup handlers
        process.on("SIGINT", async () => {
            await mcpAdapter.shutdown();
            process.exit(0);
        });

        process.on("SIGTERM", async () => {
            await mcpAdapter.shutdown();
            process.exit(0);
        });

        await mcpAdapter.start();
    }
}
