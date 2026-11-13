import { serveToolGroup } from "@genesiscz/utils/mcp/serve-group";
import type { WazeContextOptions } from "../lib/context";
import { groupOfToolset } from "./genesis-tools";
import { createWazeToolset, WAZE_MCP_INSTRUCTIONS } from "./tools";

/**
 * The `tools waze mcp` stdio server: the waze group alone, its tools under their own names (no `waze_` prefix). The
 * live-map tab it opens closes when the client closes stdin, or on SIGINT or SIGTERM.
 */
export function startMcpServer(opts: WazeContextOptions = {}): Promise<void> {
    return serveToolGroup(
        { id: "waze", prefix: "", optIn: true, load: async () => groupOfToolset(createWazeToolset(opts), "") },
        { name: "waze", version: "1.0.0", instructions: WAZE_MCP_INSTRUCTIONS }
    );
}
