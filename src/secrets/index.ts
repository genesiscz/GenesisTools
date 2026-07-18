#!/usr/bin/env bun

import { registerScanCommand } from "@app/secrets/commands/scan";
import { enhanceHelp, runTool } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";

const program = new Command();

program
    .name("secrets")
    .description("Secret-scanning tools — find hardcoded API keys, tokens, and private keys")
    .version("1.0.0")
    .option("-v, --verbose", "Enable verbose debug logging");

registerScanCommand(program);
enhanceHelp(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "secrets" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error: ${message}`);

        if (error instanceof Error && error.stack) {
            logger.debug(error.stack);
        }

        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
