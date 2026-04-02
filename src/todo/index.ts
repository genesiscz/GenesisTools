#!/usr/bin/env bun

import { createAddCommand } from "@app/todo/commands/add";
import { createEditCommand } from "@app/todo/commands/edit";
import { createExportCommand, createImportCommand } from "@app/todo/commands/import-export";
import { createListCommand } from "@app/todo/commands/list";
import { createRemoveCommand } from "@app/todo/commands/remove";
import { createSearchCommand } from "@app/todo/commands/search";
import { createShowCommand } from "@app/todo/commands/show";
import {
    createBlockCommand,
    createCompleteCommand,
    createReopenCommand,
    createStartCommand,
} from "@app/todo/commands/status";
import { createSyncCommand } from "@app/todo/commands/sync";
import { enhanceHelp } from "@app/utils/cli";
import { Command } from "commander";

const program = new Command();

program.name("todo").description("Task tracking for AI-assisted development sessions").version("1.0.0");

program.addCommand(createAddCommand());
program.addCommand(createListCommand());
program.addCommand(createShowCommand());
program.addCommand(createStartCommand());
program.addCommand(createBlockCommand());
program.addCommand(createCompleteCommand());
program.addCommand(createReopenCommand());
program.addCommand(createEditCommand());
program.addCommand(createRemoveCommand());
program.addCommand(createSearchCommand());
program.addCommand(createSyncCommand());
program.addCommand(createExportCommand());
program.addCommand(createImportCommand());

enhanceHelp(program);

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(`Unexpected error: ${err}`);
    process.exit(1);
});
