#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { Command } from "commander";
import { registerAddCommand } from "./commands/add";
import { registerEditCommand } from "./commands/edit";
import { registerHistoryCommand } from "./commands/history";
import { registerListCommand } from "./commands/list";
import { registerRemoveCommand } from "./commands/remove";
import { registerRunCommand } from "./commands/run";
import { registerShowCommand } from "./commands/show";

const program = new Command();

registerRunCommand(program);
registerAddCommand(program);
registerRemoveCommand(program);
registerListCommand(program);
registerShowCommand(program);
registerEditCommand(program);
registerHistoryCommand(program);

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        process.exit(1);
    }
}

main();
