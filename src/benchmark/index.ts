#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
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
    await runTool(program, { tool: "benchmark" });
}

main();
