#!/usr/bin/env bun

/**
 * JSON/TOON tool
 *
 * Usage:
 *   tools json [file]            Convert between JSON and TOON (default command)
 *   tools json schema [file]     Infer a TypeScript interface, JSON Schema, or skeleton
 */

import { registerConvertCommand } from "@app/json/commands/convert";
import { registerSchemaCommand } from "@app/json/commands/schema";
import { logger } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";

const program = new Command();

program
    .name("json")
    .description("JSON/TOON converter - Convert data between JSON and TOON formats, or infer a schema from JSON");

registerConvertCommand(program);
registerSchemaCommand(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "json" });
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
