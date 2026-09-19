import type { ToolEntry } from "@app/genesis-tools-mcp/lib/server";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { JevMcpRegistry } from "./registry";
import { registerJevMcpTools } from "./server";

const { log } = logger.scoped("jev-route");

/**
 * The Jev tools in the shape the genesis-tools MCP registry consumes (capability `jev`).
 *
 * `tools jev mcp` keeps serving the same registry on its own, so a host that wants only Jev can
 * point at that door; this adapter is what makes the tools appear beside `question_answer` on
 * `tools genesis-tools-mcp` without a second copy of any schema or handler.
 */
export function jevToolEntries(): Record<string, ToolEntry> {
    const registry = registerJevMcpTools(new JevMcpRegistry());
    const entries: Record<string, ToolEntry> = {};
    for (const tool of registry.list()) {
        entries[tool.name] = {
            description: tool.description,
            inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }),
            handler: async (args, context) => {
                const result = await tool.run(args, { signal: context?.signal });
                return SafeJSON.stringify(result);
            },
        };
    }

    log.debug({ tools: Object.keys(entries) }, "Jev tools adapted for the genesis-tools MCP");
    return entries;
}
