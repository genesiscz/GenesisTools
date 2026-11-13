#!/usr/bin/env bun

import { registerConfigureCommand } from "@app/automate/commands/configure.ts";
import { registerCreateCommand } from "@app/automate/commands/create.ts";
import { registerCredentialsCommand } from "@app/automate/commands/credentials.ts";
import { registerDaemonCommand } from "@app/automate/commands/daemon.ts";
import { registerListCommand } from "@app/automate/commands/list.ts";
import { registerRunCommand } from "@app/automate/commands/run.ts";
import { registerShowCommand } from "@app/automate/commands/show.ts";
import { registerStepCommands } from "@app/automate/commands/steps.ts";
import { registerTaskCommand } from "@app/automate/commands/task.ts";
import { ensureStorage } from "@app/automate/lib/storage.ts";
import { runTool } from "@genesiscz/utils/cli";
import { answerReadmeFlag } from "@genesiscz/utils/cli/readme-flag";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";

const program = new Command();

program
    .name("automate")
    .description("Run and manage automation presets that chain GenesisTools commands")
    .version("1.0.0")
    .showHelpAfterError(true);

// preset run|list|show|create
const preset = program.command("preset").description("Manage automation presets");
registerRunCommand(preset);
registerListCommand(preset);
registerShowCommand(preset);
registerCreateCommand(preset);

// step list|show
const step = program.command("step").description("Browse available step types");
registerStepCommands(step);

// task list|create|show|enable|disable|delete|run|history
const task = program.command("task").description("Manage scheduled tasks and view run history");
registerTaskCommand(task);

// daemon start|status|tail|install|uninstall
registerDaemonCommand(program);

// configure (wizard + credentials subgroup)
const configure = registerConfigureCommand(program);
registerCredentialsCommand(configure);

async function main(): Promise<void> {
    // Reading the README must not create the automation folders or copy the bundled presets.
    await answerReadmeFlag(import.meta.dir);
    await ensureStorage();

    if (process.argv.length <= 2) {
        program.help();
        return;
    }

    await runTool(program, { tool: "automate" });
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
