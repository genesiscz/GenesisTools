#!/usr/bin/env bun

import { registerRedactCommand } from "@app/secrets/commands/redact";
import { registerScanCommand } from "@app/secrets/commands/scan";
import { enhanceHelp, runTool } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";

const program = new Command();

program
    .name("secrets")
    .description("Secret tools: scan a tree for hardcoded keys, or reversibly redact secrets and PII from text")
    .version("1.0.0")
    .option("-v, --verbose", "Enable verbose debug logging");

registerScanCommand(program);
registerRedactCommand(program);
enhanceHelp(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "secrets" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(message);

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
