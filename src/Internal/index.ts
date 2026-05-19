#!/usr/bin/env bun

import { Command } from "commander";
import { runTool } from "@app/utils/cli";

const program = new Command();

program.name("internal").description("Internal tools — not for public use");

const { registerReasCommand } = await import("./commands/reas/index");
registerReasCommand(program);

await program.parseAsync(process.argv);

// CODEMOD-4b: review & fold existing parse/readme/verbose into this
await runTool(program, { tool: "Internal" });

