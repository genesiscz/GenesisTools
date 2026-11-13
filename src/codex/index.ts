#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { codexSpec } from "./lib/spec";
import { CODEX_REGISTRARS } from "./registrars";

const program = new Command();

program.name("codex").description(codexSpec.description);

await runTool(program, { tool: "codex", registrars: CODEX_REGISTRARS });
