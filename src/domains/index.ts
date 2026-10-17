#!/usr/bin/env bun

import { createCheckCommand } from "@app/domains/commands/check";
import { createHackCommand } from "@app/domains/commands/hack";
import { createInfoCommand } from "@app/domains/commands/info";
import { createPriceCommand } from "@app/domains/commands/price";
import { createProvidersCommand } from "@app/domains/commands/providers";
import { createSearchCommand } from "@app/domains/commands/search";
import { createSuggestCommand } from "@app/domains/commands/suggest";
import { createTldsCommand } from "@app/domains/commands/tlds";
import { createVibeCommand } from "@app/domains/commands/vibe";
import { createWatchCommand } from "@app/domains/commands/watch";
import { enhanceHelp, runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { clackBackend } from "@genesiscz/utils/prompts/p/clack-backend";
import { Command } from "commander";

p.setBackend(clackBackend);

const program = new Command();

program
    .name("domains")
    .description("Find a domain you can actually buy: generate, check, price, vet and watch names")
    .version("1.0.0");

program.addCommand(createSearchCommand());
program.addCommand(createCheckCommand());
program.addCommand(createSuggestCommand());
program.addCommand(createHackCommand());
program.addCommand(createInfoCommand());
program.addCommand(createPriceCommand());
program.addCommand(createTldsCommand());
program.addCommand(createVibeCommand());
program.addCommand(createWatchCommand());
program.addCommand(createProvidersCommand());

enhanceHelp(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "domains" });
    } catch (error) {
        out.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

main().catch((error) => {
    out.error(`Unexpected error: ${error}`);
    process.exit(1);
});
