import type { ToolEntry } from "@app/genesis-tools-mcp/lib/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type AlzaToolset, createAlzaToolset } from "./tools";

/** Prefix for this group in the shared genesis-tools registry, so generic names such as `search_products` stay Alza's. */
export const ALZA_TOOL_PREFIX = "alza_";

let toolset: AlzaToolset | undefined;

function sharedToolset(): AlzaToolset {
    toolset ??= createAlzaToolset();
    return toolset;
}

function resultText(result: CallToolResult): string {
    return result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
}

/**
 * The `tools alza mcp` tools in the shape the genesis-tools registry consumes (capability `alza`, opt-in). Each handler
 * is the same `call` the standalone server serves, over one account context; an error result becomes a thrown error,
 * which the registry reports as `isError`.
 */
export function alzaToolEntries(): Record<string, ToolEntry> {
    return Object.fromEntries(
        sharedToolset().tools.map((tool): [string, ToolEntry] => [
            `${ALZA_TOOL_PREFIX}${tool.name}`,
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

/** Ends the account context and its Chrome sidecar; the server calls it when its stdin ends. */
export async function closeAlzaTools(): Promise<void> {
    await toolset?.close();
}
