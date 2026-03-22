import * as p from "@clack/prompts";
import { Command } from "commander";
import { registerAddCommand } from "./commands/add";
import { registerRebuildCommand } from "./commands/rebuild";
import { registerRemoveCommand } from "./commands/remove";
import { registerSearchCommand } from "./commands/search";
import { registerStatusCommand } from "./commands/status";
import { registerWatchCommand } from "./commands/watch";

const program = new Command();

program
    .name("indexer")
    .description("Semantic code indexer with AST-aware chunking and hybrid search")
    .version("1.0.0")
    .showHelpAfterError(true);

registerAddCommand(program);
registerStatusCommand(program);
registerSearchCommand(program);
registerWatchCommand(program);
registerRebuildCommand(program);
registerRemoveCommand(program);

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
