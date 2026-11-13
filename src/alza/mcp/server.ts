import { serveToolGroup } from "@genesiscz/utils/mcp/serve-group";
import type { StorefrontId } from "../lib/storefront";
import { groupOfToolset } from "./genesis-tools";
import { ALZA_MCP_INSTRUCTIONS, createAlzaToolset } from "./tools";

/**
 * The `tools alza mcp` stdio server: the alza group alone, its tools under their own names (no `alza_` prefix). stdin's
 * end, SIGINT and SIGTERM close the account context and its Chrome worker.
 */
export function startMcpServer(opts: { storefront?: StorefrontId; includeRaw?: boolean } = {}): Promise<void> {
    return serveToolGroup(
        { id: "alza", prefix: "", optIn: true, load: async () => groupOfToolset(createAlzaToolset(opts), "") },
        { name: "alza", version: "1.0.0", instructions: ALZA_MCP_INSTRUCTIONS }
    );
}
