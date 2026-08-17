/**
 * Shared chrome-devtools-mcp client.
 *
 * Spawns `chrome-devtools-mcp` directly with `--browserUrl` pointed at a
 * CDP endpoint, bypassing Claude Code's own MCP server config entirely.
 * Claude Code's MCP servers are spawned once at session start with a fixed
 * argv from ~/.claude.json — there is no tool call that redirects an
 * already-running one to a different browser or adds launch flags without
 * editing that config and restarting the whole session. Being our own
 * client/server pair sidesteps that: any command in this repo can attach to
 * a specific browser on demand, with no persistent config change and no
 * restart.
 *
 * First user was the youtube extension tooling (`src/youtube/lib/devtools/`),
 * which keeps its own defaults on top of this; `tools spotify play` drives the
 * user's logged-in browser through the same client.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export interface DevtoolsClientOpts {
    /** CDP endpoint of an already-running browser, e.g. `http://127.0.0.1:9222`. */
    cdpUrl: string;
    /** MCP client name reported to the server. */
    clientName?: string;
}

export async function connectDevtoolsClient(opts: DevtoolsClientOpts): Promise<Client> {
    const transport = new StdioClientTransport({
        command: "chrome-devtools-mcp",
        args: ["--browserUrl", opts.cdpUrl],
    });
    const client = new Client(
        { name: opts.clientName ?? "genesis-devtools-client", version: "0.1.0" },
        { capabilities: {} }
    );
    await client.connect(transport);
    return client;
}

/** Connects, runs `fn`, and always closes the client afterward — even on throw. */
export async function withDevtoolsClient<T>(fn: (client: Client) => Promise<T>, opts: DevtoolsClientOpts): Promise<T> {
    const client = await connectDevtoolsClient(opts);
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

/** Concatenated text blocks of a tool result. The usual thing you want. */
export function toolText(result: unknown): string {
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter((block): block is { type: string; text: string } => {
            const b = block as { type?: unknown; text?: unknown };

            return b.type === "text" && typeof b.text === "string";
        })
        .map((block) => block.text)
        .join("\n");
}
