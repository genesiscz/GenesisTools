#!/usr/bin/env bun
import { enhanceHelp, runTool } from "@genesiscz/utils/cli";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { Command } from "commander";
import { registerGetCommand } from "./commands/get";
import { registerMcpCommand } from "./commands/mcp";

handleReadmeFlag(import.meta.url);

const program = new Command()
    .name("fetch")
    .description(
        "Fetch a web page as Markdown, raw HTML or schema.org JSON-LD, through Bun's fetch or a real Chrome " +
            "fingerprint for sites behind Cloudflare and other bot walls. Also an MCP server (fetch mcp)."
    );

registerGetCommand(program);
registerMcpCommand(program);
enhanceHelp(program);

if (import.meta.main) {
    await runTool(program, { tool: "fetch" });
}
