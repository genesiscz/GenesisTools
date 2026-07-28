/**
 * Example of a MCP client that lists the contents of the user's home directory.
 */

import { out } from "@genesiscz/utils/logger";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const transport = new StdioClientTransport({
    command: "bunx",
    args: ["@modelcontextprotocol/server-filesystem", "~/"],
});

const client = new Client({
    name: "example-client",
    version: "1.0.0",
});

await client.connect(transport);

const tools = await client.listTools();
out.println(tools);

const dir = await client.callTool({
    name: "list_directory",
    arguments: {
        path: "~/",
    },
});

out.println(dir);
