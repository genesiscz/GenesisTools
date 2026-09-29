#!/usr/bin/env bun
import { registerComputerUseCommands } from "@app/control/commands/computer-use";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";

const program = new Command()
    .name("computer-use")
    .description(
        "macOS Computer Use for agents: MCP server, scripts and prepare, over the native AX/CoreGraphics/Vision core in src/control. No Codex or Sky dependency. `tools control` is the full CLI on the same core."
    );
registerComputerUseCommands(program, { primary: true });
const run = program.commands.find((command) => command.name() === "computer-run");
run?.name("run");
await runTool(program, { tool: "computer-use" });
