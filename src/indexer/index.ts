import * as p from "@clack/prompts";
import { Command } from "commander";
import { registerAddCommand } from "./commands/add";
import { registerBenchVectorsCommand } from "./commands/bench-vectors";
import { registerBenchmarkCommand } from "./commands/benchmark";
import { registerContextCommand } from "./commands/context";
import { registerGraphCommand } from "./commands/graph";
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
        // Exec the MCP server as a separate process so it owns stdin/stdout
        const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/mcp-server.ts`], {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        });

        process.on("SIGINT", () => proc.kill());
        process.on("SIGTERM", () => proc.kill());
        await proc.exited;
        process.exit(proc.exitCode ?? 0);
    });

async function main(): Promise<void> {
    if (process.argv.length <= 2) {
        program.outputHelp();
        return;
    }

    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

main().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
