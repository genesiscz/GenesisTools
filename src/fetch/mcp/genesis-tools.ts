import type { ToolEntry } from "@genesiscz/utils/mcp/tool-entry";
import type { LoadedToolGroup } from "@genesiscz/utils/mcp/tool-group";
import { z } from "zod";
import { Fetcher } from "../lib/fetcher";
import { FETCH_TOOLS, toolAnswer } from "./tools";

/** A resident server ends its idle Chrome worker after a minute; the next chrome request starts a new one. */
const IDLE_CLOSE_MS = 60_000;

const FETCH_ANNOTATIONS: ToolEntry["annotations"] = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};

/**
 * The `fetch_*` tools as one group (capability `fetch`), over one Fetcher: the genesis-tools registry mounts it, and
 * `tools fetch mcp` serves it alone, so both doors fetch, escalate and refuse alike. `close` ends the Chrome worker.
 */
export function toolGroup(): LoadedToolGroup {
    const fetcher = new Fetcher({ idleCloseMs: IDLE_CLOSE_MS });
    return {
        entries: Object.fromEntries(
            FETCH_TOOLS.map((tool): [string, ToolEntry] => [
                tool.name,
                {
                    description: tool.description,
                    inputSchema: z.toJSONSchema(tool.schema, { io: "input" }),
                    annotations: FETCH_ANNOTATIONS,
                    handler: async (args, context) =>
                        toolAnswer(await tool.run({ fetcher, args, signal: context?.signal })),
                },
            ])
        ),
        close: () => fetcher.close(),
    };
}
