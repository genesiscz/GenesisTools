import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { IndexerManager } from "../lib/manager";

interface RemoveOptions {
    force?: boolean;
}

export function registerRemoveCommand(program: Command): void {
    program
        .command("remove")
        .description("Remove an index and its data")
        .argument("<name>", "Index name to remove")
        .option("--force", "Skip confirmation (required in non-TTY)")
        .action(async (name: string, opts: RemoveOptions) => {
            const manager = await IndexerManager.load();

            try {
                const names = manager.getIndexNames();

                if (!names.includes(name)) {
                    p.log.error(`Index "${name}" not found`);
                    process.exit(1);
                }

                if (!opts.force) {
                    if (!process.stdout.isTTY || !process.stdin.isTTY) {
                        p.log.error("Use --force in non-interactive mode");
                        process.exit(1);
                    }

                    const confirmed = await p.confirm({
                        message: `Remove index "${name}" and all its data?`,
                    });

                    if (p.isCancel(confirmed) || !confirmed) {
                        p.log.info("Cancelled");
                        return;
                    }
                }

                await manager.removeIndex(name);
                p.log.success(`Index "${pc.bold(name)}" removed`);
            } finally {
                await manager.close();
            }
        });
}
