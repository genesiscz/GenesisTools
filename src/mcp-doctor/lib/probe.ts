import { logger } from "@app/logger";
import { withTimeout } from "@app/utils/async";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { classifyResult } from "./report";
import type { NormalizedServer, ProbeResult, StdioServer } from "./types";
import { isInvalidServer } from "./types";

const CLIENT_INFO = { name: "mcp-doctor", version: "1.0.0" };

interface ProbeOptions {
    timeoutMs: number;
    slowThresholdMs: number;
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
    if (server.transport === "sse") {
        return new SSEClientTransport(url);
    }

    return new StreamableHTTPClientTransport(url);
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
        logger.warn({ server: server.name, err }, "mcp-doctor: probe failed");
    } finally {
        try {
            await client.close();
        } catch (closeErr) {
            logger.debug({ server: server.name, closeErr }, "mcp-doctor: close failed");
        }
    }

    const { status, latencyMs } = classifyResult({
        startedAt,
        finishedAt,
        error,
        slowThresholdMs: opts.slowThresholdMs,
        timeoutMs: opts.timeoutMs,
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
