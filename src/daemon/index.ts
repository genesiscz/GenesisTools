#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { handleReadmeFlag } from "@app/utils/readme";
import { ensureStorage } from "./lib/config";
import { registerStartCommand } from "./commands/start";
import { registerStopCommand } from "./commands/stop";
import { registerStatusCommand } from "./commands/status";
import { registerInstallCommand } from "./commands/install";
import { registerConfigCommand } from "./commands/config";
import { registerLogsCommand } from "./commands/logs";
import { runInteractiveMenu } from "./interactive/menu";

handleReadmeFlag(import.meta.url);

const program = new Command();

program
    .name("daemon")
    .description("General-purpose background task scheduler daemon")
    .version("1.0.0")
    .showHelpAfterError(true);

registerStartCommand(program);
registerStopCommand(program);
registerStatusCommand(program);
registerInstallCommand(program);
registerConfigCommand(program);
registerLogsCommand(program);

async function main(): Promise<void> {
    await ensureStorage();

    if (process.argv.length <= 2) {
        p.intro(pc.bgCyan(pc.white(" daemon ")));
        await runInteractiveMenu();
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
