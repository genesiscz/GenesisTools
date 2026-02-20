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
import logger from "@app/logger.ts";
import { handleReadmeFlag } from "@app/utils/readme.ts";
import * as p from "@clack/prompts";
import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

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
    await ensureStorage();

    if (process.argv.length <= 2) {
        program.help();
        return;
    }

    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        logger.error({ error }, "Automate command failed");
        p.log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
