import { entryFromMcpTool, type ToolEntry } from "@app/genesis-tools-mcp/lib/tool-entry";
import { type AlzaToolset, createAlzaToolset } from "./tools";

/** Prefix for this group in the shared genesis-tools registry, so generic names such as `search_products` stay Alza's. */
export const ALZA_TOOL_PREFIX = "alza_";

let toolset: AlzaToolset | undefined;

function sharedToolset(): AlzaToolset {
    toolset ??= createAlzaToolset();
    return toolset;
}

/**
 * The `tools alza mcp` tools in the shape the genesis-tools registry consumes (capability `alza`, opt-in). Each handler
 * is the same `call` the standalone server serves, over one account context, its structured result included (the
 * complaint_claims detail actions and the raw account answers live only there); an error result becomes a thrown
 * error, which the registry reports as `isError`.
 */
export function alzaToolEntries(): Record<string, ToolEntry> {
    return Object.fromEntries(
        sharedToolset().tools.map((tool): [string, ToolEntry] => [
            `${ALZA_TOOL_PREFIX}${tool.name}`,
            entryFromMcpTool(tool),
        ])
    );
}

/** Ends the account context and its Chrome worker; the server calls it when its stdin ends. */
export async function closeAlzaTools(): Promise<void> {
    await toolset?.close();
}
