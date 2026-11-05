import type { UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { isGatewayOauth } from "../auth/policy.ts";
import { hostedServer } from "./hosted.ts";

/**
 * Where `gateway stdio --server <name>` posts the JSON-RPC lines it reads from stdin.
 *
 * - `gateway`: the local gateway serves the server, either with the OAuth token GenesisTools holds or as a
 *   hosted stdio server. The relay adds only the local gateway header.
 * - `direct`: a plain HTTP server. The relay posts to the server's own url with the headers stored in the
 *   unified config. Those headers stay inside this process: never in argv, a log line or a provider config.
 * - `refused`: the relay cannot reach the server; `reason` says why.
 *
 * The relay does not negotiate a protocol version: the client's own `initialize` goes through as written.
 */
export type StdioRelayRoute =
    | { kind: "gateway" }
    | { kind: "direct"; url: string; headers: Record<string, string> }
    | { kind: "refused"; reason: string };

export function stdioRelayRoute(name: string, entry: UnifiedMCPServerConfig | undefined): StdioRelayRoute {
    // A hosted server is routed by name, like the gateway itself does, so it needs no unified entry.
    if (hostedServer(name) || isGatewayOauth(entry)) {
        return { kind: "gateway" };
    }

    if (!entry) {
        return { kind: "refused", reason: `${name} is not in the unified config` };
    }

    const url = entry.url ?? entry.httpUrl;

    if (!url) {
        return { kind: "refused", reason: `${name} is a stdio server; a client can start its command directly` };
    }

    if (entry.type === "sse") {
        return { kind: "refused", reason: `${name} uses the sse transport; the relay speaks Streamable HTTP only` };
    }

    return { kind: "direct", url, headers: { ...entry.headers } };
}
