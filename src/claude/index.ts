#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { addGlobalVerboseOption } from "@genesiscz/utils/cli/commander";
import { logger } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { clackBackend } from "@genesiscz/utils/prompts/p/clack-backend";

// Use clack backend for this tool
p.setBackend(clackBackend);

import { Command } from "commander";
import { CLAUDE_REGISTRARS } from "./registrars";

const program = new Command();

program
    .name("claude")
    .description("Claude Code tools: history, resume, desktop sync, usage, config, migration")
    .version("1.0.0")
    .showHelpAfterError(true);

addGlobalVerboseOption(program);

async function main(): Promise<void> {
    await runTool(program, { tool: "claude", registrars: CLAUDE_REGISTRARS });
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
