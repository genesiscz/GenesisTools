#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import pc from "picocolors";
import { registerConfigCommand } from "./commands/config";
import { registerInstallCommand } from "./commands/install";
import { registerLogsCommand } from "./commands/logs";
import { registerRestartCommand } from "./commands/restart";
import { registerRunCommand } from "./commands/run";
import { registerStartCommand } from "./commands/start";
import { registerStatsCommand } from "./commands/stats";
import { registerStatusCommand } from "./commands/status";
import { registerStopCommand } from "./commands/stop";
import { runInteractiveMenu } from "./interactive/menu";
import { ensureStorage } from "./lib/config";

const program = new Command();

program
    .name("daemon")
    .description("General-purpose background task scheduler daemon")
    .version("1.0.0")
    .showHelpAfterError(true);

registerStartCommand(program);
registerStopCommand(program);
registerRestartCommand(program);
registerStatusCommand(program);
registerInstallCommand(program);
registerConfigCommand(program);
registerLogsCommand(program);
registerStatsCommand(program);
registerRunCommand(program);

async function main(): Promise<void> {
    await ensureStorage();

    if (process.argv.length <= 2) {
        p.intro(pc.bgCyan(pc.white(" daemon ")));
        await runInteractiveMenu();
        return;
    }

    await runTool(program, { tool: "daemon" });
}

main().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
