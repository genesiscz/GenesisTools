#!/usr/bin/env bun
import { registerComputerUseCommands } from "@app/control/commands/computer-use";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";

const program = new Command()
    .name("computer-use")
    .description("Independent macOS Computer Use over native AX/CoreGraphics/Vision. No Codex or Sky dependency.");
registerComputerUseCommands(program);
const run = program.commands.find((command) => command.name() === "computer-run");
run?.name("run");
await runTool(program, { tool: "computer-use" });
