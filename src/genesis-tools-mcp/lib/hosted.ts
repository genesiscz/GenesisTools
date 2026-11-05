import type { HostedPeer } from "@app/mcp-manager/lib/gateway/hosted-protocol";
import { logger } from "@genesiscz/utils/logger";
import { serveGenesisToolsHttp, UNKNOWN_CALLER } from "./http";
import { resolveCallerFromPeer } from "./http-caller";

/**
 * The genesis-tools MCP server as the gateway hosts it (`src/mcp-manager/lib/gateway/hosted.ts`), run in the
 * gateway's child process: the caller is the harness process that owns the request's connection.
 */
export function serveHostedGenesisTools(request: Request, peer: HostedPeer | null): Promise<Response> {
    const peerCaller = peer && request.method === "POST" ? resolveCallerFromPeer(peer) : null;
    const caller = peerCaller ?? UNKNOWN_CALLER;
    logger.debug(
        {
            server: "genesis-tools",
            callerPid: peerCaller?.pid ?? null,
            agent: caller.agent,
            sessionId: caller.sessionId,
        },
        "gateway hosted call"
    );
    return serveGenesisToolsHttp(request, caller);
}
