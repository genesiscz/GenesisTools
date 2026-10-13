#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { Command } from "commander";
import { registerFileCommands } from "./commands/files";
import { registerLedgerCommands } from "./commands/ledger";

const program = new Command()
    .name(toolCommand("compress"))
    .description("zstd for files and folders: verified packs, restores, presets, trials and a searchable ledger");

registerFileCommands(program);
registerLedgerCommands(program);

await runTool(program, { tool: "compress" });
