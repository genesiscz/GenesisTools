import { withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import type { Transport } from "@modelcontextprotocol/client";
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DIAGNOSTIC_HEADER, GATEWAY_HEADER } from "../auth/constants.ts";
import { classifyResult } from "./report.ts";
import type { NormalizedServer, ProbeResult, RemoteServer, StdioServer } from "./types.ts";
import { isInvalidServer } from "./types.ts";

const CLIENT_INFO = { name: "mcp-manager-doctor", version: "1.0.0" };

interface ProbeOptions {
    timeoutMs: number;
    slowThresholdMs: number;
}

/**
 * The headers of a remote entry, as the MCP client's `requestInit`. A client sends them on every request,
 * and some servers refuse the handshake without them: the local gateway wants its token header, a hosted
 * server wants a bearer token. A probe that left them out reported those servers as down.
 *
 * A request that carries the gateway token also carries the diagnostic header, so the gateway answers
 * "needs a login" instead of refreshing a token or starting a login for a health check.
 */
export function remoteRequestInit(server: RemoteServer): RequestInit | undefined {
    if (!server.headers || Object.keys(server.headers).length === 0) {
        return undefined;
    }

    const headers: Record<string, string> = { ...server.headers };
    const viaGateway = Object.keys(headers).some((name) => name.toLowerCase() === GATEWAY_HEADER.toLowerCase());

    if (viaGateway) {
        headers[DIAGNOSTIC_HEADER] = "1";
    }

    return { headers };
}

function buildTransport(server: Exclude<NormalizedServer, { invalidReason: string }>): Transport {
    if (server.transport === "stdio") {
        const stdio = server as StdioServer;
        const mergedEnv = { ...process.env, ...stdio.env };
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(mergedEnv)) {
            if (value !== undefined) {
                env[key] = value;
            }
        }

        return new StdioClientTransport({
            command: stdio.command,
            args: stdio.args,
            env,
            cwd: stdio.cwd,
            stderr: "ignore",
        });
    }

    const url = new URL(server.url);
    const requestInit = remoteRequestInit(server);
    if (server.transport === "sse") {
        return new SSEClientTransport(url, { requestInit });
    }

    return new StreamableHTTPClientTransport(url, { requestInit });
}

export async function probeServer(server: NormalizedServer, opts: ProbeOptions): Promise<ProbeResult> {
    const baseResult = {
        name: server.name,
        source: server.source,
        transport: server.transport,
        toolCount: 0,
        tools: [] as string[],
        resourceCount: 0,
        promptCount: 0,
        serverInfo: null as { name: string; version: string } | null,
    };

    if (isInvalidServer(server)) {
        return {
            ...baseResult,
            status: "invalid",
            latencyMs: null,
            error: server.invalidReason,
        };
    }

    const client = new Client(CLIENT_INFO);
    const startedAt = Date.now();
    let finishedAt: number | null = null;
    let error: string | null = null;
    let tools: string[] = [];
    let resourceCount = 0;
    let promptCount = 0;
    let serverInfo: { name: string; version: string } | null = null;

    try {
        const transport = buildTransport(server);
        await withTimeout(client.connect(transport), opts.timeoutMs);
        finishedAt = Date.now();

        const caps = client.getServerCapabilities();
        const info = client.getServerVersion();
        if (info) {
            serverInfo = { name: info.name, version: info.version };
        }

        const toolList = await withTimeout(client.listTools(), opts.timeoutMs);
        tools = toolList.tools.map((t) => t.name);

        if (caps?.resources) {
            const res = await withTimeout(client.listResources(), opts.timeoutMs);
            resourceCount = res.resources.length;
        }

        if (caps?.prompts) {
            const prompts = await withTimeout(client.listPrompts(), opts.timeoutMs);
            promptCount = prompts.prompts.length;
        }
    } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        logger.warn({ server: server.name, err }, "mcp-manager doctor: probe failed");
    } finally {
        try {
            await client.close();
        } catch (closeErr) {
            logger.debug({ server: server.name, closeErr }, "mcp-manager doctor: close failed");
        }
    }

    const { status, latencyMs } = classifyResult({
        startedAt,
        finishedAt,
        error,
        slowThresholdMs: opts.slowThresholdMs,
    });

    return {
        ...baseResult,
        status,
        latencyMs,
        tools,
        toolCount: tools.length,
        resourceCount,
        promptCount,
        serverInfo,
        error,
    };
}
