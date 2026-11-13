import { serveToolGroup } from "@genesiscz/utils/mcp/serve-group";
import { toolGroup } from "./genesis-tools";

/**
 * The `tools fetch mcp` stdio server: the fetch group alone, over one Fetcher. stdin's end, SIGINT and SIGTERM close the
 * fetcher (its Chrome worker and connections).
 */
export function startFetchMcpServer(): Promise<void> {
    return serveToolGroup(
        { id: "fetch", prefix: "fetch_", optIn: false, load: async () => toolGroup() },
        { name: "fetch", version: "1.0.0" }
    );
}
