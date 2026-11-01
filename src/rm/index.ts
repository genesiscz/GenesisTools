#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { createRmProgram } from "./program";

if (import.meta.main) {
    await runTool(createRmProgram(), { tool: "rm" });
}
