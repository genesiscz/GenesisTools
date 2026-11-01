import type { ToolEntry } from "@app/genesis-tools-mcp/lib/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createWazeToolset, type WazeToolset } from "./tools";

/** Prefix for this group in the shared genesis-tools registry, so generic names such as `route` stay Waze's. */
export const WAZE_TOOL_PREFIX = "waze_";

let toolset: WazeToolset | undefined;

function sharedToolset(): WazeToolset {
    toolset ??= createWazeToolset();
    return toolset;
}

function resultText(result: CallToolResult): string {
    return result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
}

/**
 * The `tools waze mcp` tools in the shape the genesis-tools registry consumes (capability `waze`, opt-in). Each handler
 * is the same `call` the standalone server serves, over one shared context (one live-map tab, opened on the first
 * call); an error result becomes a thrown error, which the registry reports as `isError`.
 */
export function wazeToolEntries(): Record<string, ToolEntry> {
    return Object.fromEntries(
        sharedToolset().tools.map((tool): [string, ToolEntry] => [
            `${WAZE_TOOL_PREFIX}${tool.name}`,
            {
                description: tool.description,
                inputSchema: tool.inputSchema,
                handler: async (args) => {
                    const result = await tool.call(args);
                    const text = resultText(result);
                    if (result.isError) {
                        throw new Error(text);
                    }

                    return text;
                },
            },
        ])
    );
}

/** Closes the live-map tab the group opened; the server calls it when its stdin ends. */
export async function closeWazeTools(): Promise<void> {
    await toolset?.close();
}
