#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerLogsCommand } from "./commands/logs";
import { registerProbeCommand } from "./commands/probe";

const program = new Command()
    .name("genesis-tools")
    .description(
        "Developer tools for GenesisTools itself: what failed, crashed or ran slow, and who ran it; what of it this Mac has"
    );

registerLogsCommand(program);
registerProbeCommand(program);

if (import.meta.main) {
    await runTool(program, { tool: "genesis-tools" });
}
