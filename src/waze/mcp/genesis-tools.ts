import { entryFromMcpTool } from "@genesiscz/utils/mcp/tool-entry";
import type { LoadedToolGroup } from "@genesiscz/utils/mcp/tool-group";
import { createWazeToolset, type WazeToolset } from "./tools";

/** Prefix for this group in the shared genesis-tools registry, so generic names such as `route` stay Waze's. */
export const WAZE_TOOL_PREFIX = "waze_";

/**
 * A toolset as a group, each tool named `<prefix><name>` (the shared registry's `waze_` unless the caller passes
 * another, as the standalone server passes ""). Each handler is the same `call` the toolset serves, over one shared context (one live-map tab,
 * opened on the first call), its structured result included; an error result becomes a thrown error. `close` closes
 * the live-map tab.
 */
export function groupOfToolset(toolset: WazeToolset, prefix = WAZE_TOOL_PREFIX): LoadedToolGroup {
    return {
        entries: Object.fromEntries(toolset.tools.map((tool) => [`${prefix}${tool.name}`, entryFromMcpTool(tool)])),
        close: () => toolset.close(),
    };
}

/** The `tools waze mcp` tools as the genesis-tools registry mounts them (capability `waze`, opt-in). */
export function toolGroup(): LoadedToolGroup {
    return groupOfToolset(createWazeToolset());
}
