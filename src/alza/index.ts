#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { Command } from "commander";
import { registerCatalogCommands } from "./commands/catalog";
import { resolveStorefront } from "./commands/run";
import { STOREFRONT_IDS } from "./lib/storefront";

handleReadmeFlag(import.meta.url);

const program = new Command()
    .name("alza")
    .description(
        "Alza.cz catalog from the terminal and as an MCP server: search, products, reviews, questions, deals, price history"
    )
    .option("--country [id]", `Storefront: ${STOREFRONT_IDS.join(", ")} (default cz)`)
    .option("--json", "Print the result as JSON");

registerCatalogCommands(program);

program
    .command("mcp")
    .description("Start the stdio MCP server (every command as a tool)")
    .action(async (_flags: unknown, command: Command) => {
        const storefront = await resolveStorefront(command);
        if (!storefront) {
            return;
        }

        const { startMcpServer } = await import("./mcp/server");
        await startMcpServer({ storefront });
    });

if (import.meta.main) {
    await runTool(program, { tool: "alza" });
}
