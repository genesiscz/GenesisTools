import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface DevtoolsClientOpts {
    /** CDP endpoint of an already-running, extension-loaded browser (see devtools-browser.ts). */
    cdpUrl?: string;
}

/**
 * Spawns `chrome-devtools-mcp` directly with `--browserUrl` pointed at our
 * own launched browser, bypassing Claude Code's own MCP server config
 * entirely. Claude Code's MCP servers are spawned once at session start with
 * a fixed argv from ~/.claude.json — there is no tool call that redirects an
 * already-running one to a different browser or adds launch flags without
 * editing that config and restarting the whole session. Being our own
 * client/server pair sidesteps that: any command in this repo can attach to
 * a specific extension-loaded browser on demand, with no persistent config
 * change and no restart.
 */
export async function connectDevtoolsClient(opts: DevtoolsClientOpts = {}): Promise<Client> {
    const cdpUrl = opts.cdpUrl ?? process.env.CDP_URL ?? "http://127.0.0.1:9333";
    const transport = new StdioClientTransport({
        command: "chrome-devtools-mcp",
        args: ["--browserUrl", cdpUrl],
    });
    const client = new Client({ name: "genesis-yt-devtools-client", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    return client;
}

/** Connects, runs `fn`, and always closes the client afterward — even on throw. */
export async function withDevtoolsClient<T>(
    fn: (client: Client) => Promise<T>,
    opts: DevtoolsClientOpts = {}
): Promise<T> {
    const client = await connectDevtoolsClient(opts);
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}
