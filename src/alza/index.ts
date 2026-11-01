#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { Command } from "commander";
import { registerAccountCommands } from "./commands/account";
import { registerCatalogCommands } from "./commands/catalog";
import { registerExtraCommands } from "./commands/extras";
import { resolveStorefront } from "./commands/run";
import { STOREFRONT_IDS } from "./lib/storefront";

handleReadmeFlag(import.meta.url);

const program = new Command()
    .name("alza")
    .description(
        "Alza.cz from the terminal and as an MCP server: search, products, reviews, questions, deals, price history; sign-in, basket, orders, watchdogs"
    )
    .option("--country [id]", `Storefront: ${STOREFRONT_IDS.join(", ")} (default cz)`)
    .option("--json", "Print the result as JSON");

registerCatalogCommands(program);
registerAccountCommands(program);
registerExtraCommands(program);

program
    .command("mcp")
    .description("Start the stdio MCP server (every command as a tool)")
    .option("--raw", "Also list the raw read-only escape hatch (mobile_read)")
    .action(async (flags: { raw?: boolean }, command: Command) => {
        const storefront = await resolveStorefront(command);
        if (!storefront) {
            return;
        }

        const { startMcpServer } = await import("./mcp/server");
        await startMcpServer({ storefront, includeRaw: flags.raw });
    });

if (import.meta.main) {
    await runTool(program, { tool: "alza" });
}
