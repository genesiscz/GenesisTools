import { entryFromMcpTool } from "@genesiscz/utils/mcp/tool-entry";
import type { LoadedToolGroup } from "@genesiscz/utils/mcp/tool-group";
import { type AlzaToolset, createAlzaToolset } from "./tools";

/** Prefix for this group in the shared genesis-tools registry, so generic names such as `search_products` stay Alza's. */
export const ALZA_TOOL_PREFIX = "alza_";

/**
 * A toolset as a group, each tool named `<prefix><name>` (the shared registry's `alza_` unless the caller passes
 * another, as the standalone server passes ""). Each handler is the same `call` the toolset serves, over one account context, its structured
 * result included (the complaint_claims detail actions and the raw account answers live only there); an error result
 * becomes a thrown error. `close` ends the account context and its Chrome worker.
 */
export function groupOfToolset(toolset: AlzaToolset, prefix = ALZA_TOOL_PREFIX): LoadedToolGroup {
    return {
        entries: Object.fromEntries(toolset.tools.map((tool) => [`${prefix}${tool.name}`, entryFromMcpTool(tool)])),
        close: () => toolset.close(),
    };
}

/** The `tools alza mcp` tools as the genesis-tools registry mounts them (capability `alza`, opt-in). */
export function toolGroup(): LoadedToolGroup {
    return groupOfToolset(createAlzaToolset());
}
