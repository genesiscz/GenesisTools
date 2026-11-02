import { entryFromMcpTool, type ToolEntry } from "@app/genesis-tools-mcp/lib/tool-entry";
import { createWazeToolset, type WazeToolset } from "./tools";

/** Prefix for this group in the shared genesis-tools registry, so generic names such as `route` stay Waze's. */
export const WAZE_TOOL_PREFIX = "waze_";

let toolset: WazeToolset | undefined;

function sharedToolset(): WazeToolset {
    toolset ??= createWazeToolset();
    return toolset;
}

/**
 * The `tools waze mcp` tools in the shape the genesis-tools registry consumes (capability `waze`, opt-in). Each handler
 * is the same `call` the standalone server serves, over one shared context (one live-map tab, opened on the first
 * call), its structured result included; an error result becomes a thrown error, which the registry reports as
 * `isError`.
 */
export function wazeToolEntries(): Record<string, ToolEntry> {
    return Object.fromEntries(
        sharedToolset().tools.map((tool): [string, ToolEntry] => [
            `${WAZE_TOOL_PREFIX}${tool.name}`,
            entryFromMcpTool(tool),
        ])
    );
}

/** Closes the live-map tab the group opened; the server calls it when its stdin ends. */
export async function closeWazeTools(): Promise<void> {
    await toolset?.close();
}
