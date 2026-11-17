#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerWorkCommands } from "./commands/register";

const program = new Command()
    .name("work")
    .description("One store of work items: handoffs, tasks, spotted items, epics, todos, with references between them");

registerWorkCommands(program);

await runTool(program, { tool: "work" });
