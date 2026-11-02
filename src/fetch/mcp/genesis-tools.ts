import type { ToolEntry } from "@app/genesis-tools-mcp/lib/server";
import { z } from "zod";
import { Fetcher } from "../lib/fetcher";
import { FETCH_TOOLS, toolText } from "./tools";

/** The genesis-tools server is resident: an idle Chrome worker ends after a minute and restarts on demand. */
const IDLE_CLOSE_MS = 60_000;

let fetcher: Fetcher | undefined;

function sharedFetcher(): Fetcher {
    fetcher ??= new Fetcher({ idleCloseMs: IDLE_CLOSE_MS });
    return fetcher;
}

/**
 * The `fetch_*` tools in the shape the genesis-tools MCP registry consumes (capability `fetch`). Each handler is the
 * same `run` that `tools fetch mcp` serves, over one shared Fetcher, so both doors fetch, escalate and refuse alike.
 */
export function fetchToolEntries(): Record<string, ToolEntry> {
    return Object.fromEntries(
        FETCH_TOOLS.map((tool): [string, ToolEntry] => [
            tool.name,
            {
                description: tool.description,
                inputSchema: z.toJSONSchema(tool.schema, { io: "input" }),
                handler: async (args, context) =>
                    toolText(await tool.run({ fetcher: sharedFetcher(), args, signal: context?.signal })),
            },
        ])
    );
}

/** Ends the shared Chrome worker; the server calls it when its stdin ends. */
export async function closeFetchTools(): Promise<void> {
    await fetcher?.close();
}
