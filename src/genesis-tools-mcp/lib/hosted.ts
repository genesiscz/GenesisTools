import type { HostedPeer } from "@app/mcp-manager/lib/gateway/hosted-protocol";
import { logger } from "@genesiscz/utils/logger";
import { serveGenesisToolsHttp } from "./http";
import { resolveCallerFromPeer } from "./http-caller";

/**
 * The genesis-tools MCP server as the gateway hosts it (`src/mcp-manager/lib/gateway/hosted.ts`), run in the
 * gateway's child process: the caller is the harness process that owns the request's connection.
 */
export function serveHostedGenesisTools(request: Request, peer: HostedPeer | null): Promise<Response> {
    const caller =
        peer && request.method === "POST"
            ? resolveCallerFromPeer(peer)
            : { agent: "unknown" as const, sessionId: null, cwd: null, pid: null, processName: null };
    logger.debug(
        { server: "genesis-tools", callerPid: caller.pid, agent: caller.agent, sessionId: caller.sessionId },
        "gateway hosted call"
    );
    return serveGenesisToolsHttp(request, caller);
}
