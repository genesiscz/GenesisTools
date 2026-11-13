#!/usr/bin/env bun

/**
 * `tools json2md` — JSON to Markdown.
 *
 * This file and everything under it is a thin door. All rendering logic lives in
 * `@genesiscz/utils/json2md`, so a downstream repo and any other consumer can wrap the same core
 * without going through a CLI.
 *
 *   tools json2md data.json                    render, shape chosen from the data
 *   tools json2md data.json --select 'users'   render one sub-tree
 *   tools json2md init ./reports/Registry      scaffold the three-file pattern
 *   tools json2md build ./reports/Registry.ts  regenerate the markdown
 *   tools json2md check ./reports/Registry.ts  is it current, stale, or hand-edited
 */

import { registerConvertCommand } from "@app/json2md/commands/convert";
import { registerDocumentCommands } from "@app/json2md/commands/document";
import { runTool } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";

const program = new Command();

program.name("json2md").description("Render JSON as Markdown: tables, lists, sections, callouts, details and mermaid");

// The default command and the subcommands both declare `--title` and `--from`. Without this,
// commander binds a flag typed AFTER a subcommand to the parent's identically named option and
// drops it, so `init --title X` silently produced an untitled document.
program.enablePositionalOptions();

registerDocumentCommands(program);
registerConvertCommand(program);

async function main(): Promise<void> {
    await runTool(program, { tool: "json2md" });
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
