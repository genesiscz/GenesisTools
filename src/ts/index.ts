#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerDuplicatesCommands } from "./commands/duplicates";
import { registerImportsCommands } from "./commands/imports";
import { registerRefactorsCommands } from "./commands/refactors";
import { registerSkeletonCommands } from "./commands/skeleton";

const program = new Command();

program
    .name("tools ts")
    .description(
        "TypeScript analysis: API skeletons, duplicate code, refactor recommendations, import graphs and cost"
    );

registerImportsCommands(program);
registerSkeletonCommands(program);
registerDuplicatesCommands(program);
registerRefactorsCommands(program);

if (import.meta.main) {
    await runTool(program, { tool: "ts" });
}
