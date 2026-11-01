import { ApifyError, actorId, sanitizeResult } from "@app/apify/lib/client";
import { logger } from "@genesiscz/utils/logger";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const PUBLIC_TOOLS = ["search-actors", "fetch-actor-details", "search-apify-docs", "fetch-apify-docs"] as const;
const READ_TOOLS = [...PUBLIC_TOOLS, "get-actor-run", "get-dataset-items", "get-key-value-store-record"];
const SERVER_TOOLS = ["fetch-actor-mcp-tool-list", "call-actor-mcp-tool"];
const REPORT_TOOL = "report-problem";

export interface ApifyMcpSession {
    callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
    listTools(): Promise<unknown>;
    close(): Promise<void>;
}

export type McpConnect = (options: { url: URL; token?: string }) => Promise<ApifyMcpSession>;

const connect: McpConnect = async ({ url, token }) => {
    const client = new Client({ name: "genesis-tools-apify", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: "error" },
        fetch: async (input, init) => {
            const target = new URL(String(input));
            if (target.origin !== "https://mcp.apify.com") {
                throw new ApifyError("Refusing to send Apify credentials outside the hosted MCP origin.");
            }
            const response = await fetch(input, {
                ...init,
                redirect: "error",
                signal: init?.signal
                    ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)])
                    : AbortSignal.timeout(60_000),
            });
            let bytes = 0;
            const limited = response.body?.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, controller) {
                        bytes += chunk.byteLength;
                        if (bytes > 16 * 1024 * 1024) {
                            controller.error(
                                new ApifyError("MCP response exceeded 16 MiB. Request fewer items or fields.")
                            );
                            return;
                        }
                        controller.enqueue(chunk);
                    },
                })
            );
            return new Response(limited, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        },
        reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
        },
    });
    try {
        await client.connect(transport, { timeout: 30_000 });
    } catch {
        await transport.close();
        throw new ApifyError("Could not connect to Apify MCP. Check connectivity and authentication.");
    }
    return {
        callTool: (params) => client.callTool(params, undefined, { timeout: 60_000, maxTotalTimeout: 60_000 }),
        listTools: () => client.listTools(undefined, { timeout: 30_000 }),
        close: () => client.close(),
    };
};

/** Only known tools can be invoked, so future server additions cannot bypass the spending guard. */
export class ApifyMcp {
    constructor(private readonly options: { token?: string; connect?: McpConnect } = {}) {}

    async invoke(options: {
        tool: string;
        args: Record<string, unknown>;
        allowUncappedCost?: boolean;
        allowReport?: boolean;
    }) {
        const { tool, args } = options;
        if (![...READ_TOOLS, ...SERVER_TOOLS, REPORT_TOOL].includes(tool)) {
            throw new ApifyError("Unsupported MCP tool. Use run start for bounded Actor runs.");
        }
        if (tool === REPORT_TOOL && !options.allowReport) {
            throw new ApifyError(
                "Reporting sends a message and enables Apify telemetry for that session. Requires --allow-report."
            );
        }
        if (SERVER_TOOLS.includes(tool) && !options.allowUncappedCost) {
            throw new ApifyError(
                "Actor MCP access may incur charges without a per-call USD cap. Requires --allow-uncapped-cost."
            );
        }
        if (!PUBLIC_TOOLS.some((name) => name === tool) && !this.options.token) {
            throw new ApifyError("This tool requires login.");
        }
        if (SERVER_TOOLS.includes(tool)) {
            if (typeof args.actor !== "string") {
                throw new ApifyError("An Actor ID or owner/name is required.");
            }
            actorId(args.actor);
        }
        if (tool === "fetch-apify-docs") {
            const url = typeof args.url === "string" ? new URL(args.url) : undefined;
            if (
                url?.protocol !== "https:" ||
                !["docs.apify.com", "crawlee.dev"].includes(url.hostname) ||
                url.username ||
                url.password ||
                url.port
            ) {
                throw new ApifyError("Use an HTTPS documentation URL on docs.apify.com or crawlee.dev.");
            }
        }
        return this.withSession({ tool, execute: (session) => session.callTool({ name: tool, arguments: args }) });
    }

    async tools() {
        return this.withSession({ execute: (session) => session.listTools() });
    }

    private async withSession(options: { tool?: string; execute: (session: ApifyMcpSession) => Promise<unknown> }) {
        const url = new URL("https://mcp.apify.com");
        url.searchParams.set("tools", options.tool ?? PUBLIC_TOOLS.join(","));
        url.searchParams.set("telemetry-enabled", options.tool === REPORT_TOOL ? "true" : "false");
        logger.debug({ tool: options.tool ?? "tools/list" }, "apify hosted MCP request");
        let session: ApifyMcpSession | undefined;
        try {
            session = await (this.options.connect ?? connect)({ url, token: this.options.token });
            const result = await options.execute(session);
            if (result !== null && typeof result === "object" && "isError" in result && result.isError === true) {
                throw new ApifyError("Apify tool returned an error.");
            }
            return sanitizeResult(result, this.options.token);
        } catch {
            throw new ApifyError(
                "Apify MCP request failed. Remote effects may have occurred; do not retry paid calls blindly."
            );
        } finally {
            if (session) {
                try {
                    await session.close();
                } catch {
                    logger.debug("apify MCP transport cleanup failed");
                }
            }
        }
    }
}
