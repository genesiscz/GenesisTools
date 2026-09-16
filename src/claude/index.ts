#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { addGlobalVerboseOption } from "@genesiscz/utils/cli/commander";
import { registerRequestedTrees } from "@genesiscz/utils/cli/lazy-registrars";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { inquirerBackend } from "@genesiscz/utils/prompts/p/inquirer-backend";

// Use inquirer backend for this tool
p.setBackend(inquirerBackend);

import { Command } from "commander";
import { CLAUDE_REGISTRARS } from "./registrars";

const program = new Command();

program
    .name("claude")
    .description("Claude Code tools: history, resume, desktop sync, usage, config, migration")
    .version("1.0.0")
    .showHelpAfterError(true);

await registerRequestedTrees({ program, registrars: CLAUDE_REGISTRARS, requested: process.argv[2] });

addGlobalVerboseOption(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "claude" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ExitPromptError") || message === "Cancelled") {
            await out.flush();
            process.exit(0);
        }
        logger.error(`Error: ${message}`);
        // Drain before exiting: `out.*` writes are fire-and-forget, so exiting in
        // the same tick can lose the diagnostic entirely (PR #360 review t12).
        await out.flush();
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
