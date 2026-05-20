#!/usr/bin/env bun

import { runTool } from "@app/utils/cli";
import { Command } from "commander";

const program = new Command();

program.name("internal").description("Internal tools — not for public use");

const { registerReasCommand } = await import("./commands/reas/index");
registerReasCommand(program);

await runTool(program, { tool: "Internal" });
