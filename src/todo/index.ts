#!/usr/bin/env bun

import { createAddCommand } from "@app/todo/commands/add";
import { enhanceHelp } from "@app/utils/cli";
import { Command } from "commander";

const program = new Command();

program
    .name("todo")
    .description("Task tracking for AI-assisted development sessions")
    .version("1.0.0");

program.addCommand(createAddCommand());

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
