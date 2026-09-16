#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerImportsCommands } from "./commands/imports";

const program = new Command();

program
    .name("tools ts")
    .description(
        "TypeScript module analysis: import graphs, measured import cost, lazy-load and barrel candidates, cycles"
    );

registerImportsCommands(program);

if (import.meta.main) {
    await runTool(program, { tool: "ts" });
}
