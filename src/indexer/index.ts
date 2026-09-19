import * as p from "@clack/prompts";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerAddCommand } from "./commands/add";
import { registerBenchVectorsCommand } from "./commands/bench-vectors";
import { registerBenchmarkCommand } from "./commands/benchmark";
import { registerContextCommand } from "./commands/context";
import { registerGraphCommand } from "./commands/graph";
import { registerMigrateVecCommand } from "./commands/migrate-vec";
import { registerModelsCommand } from "./commands/models";
import { registerRebuildCommand } from "./commands/rebuild";
import { registerRemoveCommand } from "./commands/remove";
import { registerSearchCommand } from "./commands/search";
import { registerStatusCommand } from "./commands/status";
import { registerStopCommand } from "./commands/stop";
import { registerSyncCommand } from "./commands/sync";
import { registerVerifyCommand } from "./commands/verify";
import { registerWatchCommand } from "./commands/watch";

const program = new Command();

program
    .name("indexer")
    .description("Semantic code indexer with AST-aware chunking and hybrid search")
    .version("1.0.0")
    .showHelpAfterError(true);

registerAddCommand(program);
registerModelsCommand(program);
registerStatusCommand(program);
registerSearchCommand(program);
registerStopCommand(program);
registerSyncCommand(program);
registerWatchCommand(program);
registerRebuildCommand(program);
registerMigrateVecCommand(program);
registerRemoveCommand(program);
registerVerifyCommand(program);
registerBenchmarkCommand(program);
registerBenchVectorsCommand(program);
registerGraphCommand(program);
registerContextCommand(program);

program
    .command("mcp-serve")
    .description("Start the indexer MCP server (stdio transport, for AI assistant integration)")
    .action(async () => {
        // In process, like every other tool's MCP server here. A child inheriting this process's
        // stdio owns nothing the parent did not already own, so the subprocess only added a second
        // bun start-up and a signal relay between the transport and its own terminal. The import
        // is lazy so the server's dependency graph costs nothing on any other subcommand.
        await import("./mcp-server");
    });

async function main(): Promise<void> {
    if (process.argv.length <= 2) {
        program.outputHelp();
        return;
    }

    try {
        await runTool(program, { tool: "indexer" });
    } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

main().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
