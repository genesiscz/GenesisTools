#!/usr/bin/env bun

/**
 * `tools markdown` — work on markdown files.
 *
 *   tools markdown resolve Note.md                     {{kind …}} tokens into include blocks, refreshed on each run
 *   tools markdown resolve Note.md --convert-links     first, a {{lines}} token under every link to source lines
 *   tools markdown resolve Note.md --dry-run           the proposal and its patch, the file untouched
 *   tools markdown tokens                              the kinds a note may carry
 *
 * The include logic lives in `@genesiscz/utils/markdown/includes` (json2md resolves its documents with
 * the same code); this folder is the door.
 */

import { registerResolveCommand } from "@app/markdown/commands/resolve";
import { registerTokensCommand } from "@app/markdown/commands/tokens";
import { runTool } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";

const program = new Command();

program.name("markdown").description("Markdown files: resolve {{kind …}} tokens into re-resolvable excerpts");

registerResolveCommand(program);
registerTokensCommand(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "markdown" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error: ${message}`);
        process.exitCode = 1;
    }
}

main();
