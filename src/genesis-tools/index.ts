#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerEnvCommand } from "./commands/env";
import { registerLogsCommand } from "./commands/logs";
import { registerProbeCommand } from "./commands/probe";
import { registerTriageCommand } from "./commands/triage";

const program = new Command()
    .name("genesis-tools")
    .description(
        "Developer tools for GenesisTools itself: what failed, crashed or ran slow, and who ran it; what of it this Mac has"
    );

registerEnvCommand(program);
registerLogsCommand(program);
registerProbeCommand(program);
registerTriageCommand(program);

if (import.meta.main) {
    await runTool(program, { tool: "genesis-tools" });
}
