/**
 * Example of a MCP client that lists the contents of the user's home directory.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bunx",
  args: ["@modelcontextprotocol/server-filesystem", "~/"]
});

const client = new Client(
  {
    name: "example-client",
    version: "1.0.0"
  }
);

await client.connect(transport);

const tools = await client.listTools();
console.log(tools);

const dir = await client.callTool({
  name: "list_directory",
  arguments: {
    path: "~/"
  }
});

console.log(dir);
