import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GATEWAY_HEADER } from "../auth/constants.ts";
import { isGatewayOauth, serverAuth } from "../auth/policy.ts";
import { gatewayListen, gatewayServerUrl } from "../auth/project.ts";
import { ensureGatewayClientToken } from "../auth/secrets.ts";
import { accessTokenForRequest } from "../auth/tokens.ts";
import { headersToClient, headersToUpstream, localTokenMatches, loopbackHostOk } from "./headers.ts";

export interface GatewayHandle {
    port: number;
    hostname: string;
    url: string;
    stop(): void;
}

function jsonRpcError(message: string, status = 401): Response {
    return new Response(
        SafeJSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message },
            id: null,
        }),
        {
            status,
            headers: { "Content-Type": "application/json" },
        }
    );
}

function serverNameFromPath(pathname: string): string | undefined {
    const match = pathname.match(/^\/mcp\/([^/]+)\/?$/);

    if (!match?.[1]) {
        return undefined;
    }

    return decodeURIComponent(match[1]);
}

export async function startGatewayServer(
    config: UnifiedMCPConfig,
    opts: { port?: number; hostname?: string } = {}
): Promise<GatewayHandle> {
    const listen = gatewayListen(config);
    const hostname = opts.hostname ?? listen.host;
    const port = opts.port ?? listen.port;
    const localToken = await ensureGatewayClientToken();

    const server = Bun.serve({
        hostname,
        port,
        async fetch(request) {
            const url = new URL(request.url);

            if (!loopbackHostOk(request.headers.get("host"))) {
                return new Response("loopback only", { status: 403 });
            }

            if (url.pathname.startsWith("/.well-known/")) {
                return new Response("not found", { status: 404 });
            }

            if (url.pathname === "/health") {
                return Response.json({ ok: true, service: "mcp-gateway" });
            }

            const name = serverNameFromPath(url.pathname);

            if (!name) {
                return new Response("not found", { status: 404 });
            }

            if (!localTokenMatches(request, localToken)) {
                return jsonRpcError(`missing ${GATEWAY_HEADER}. Run tools mcp-manager auth login ${name}`);
            }

            const unified = config.mcpServers[name];

            if (!unified || !isGatewayOauth(unified)) {
                return jsonRpcError(`${name} is not an oauth gateway server`, 404);
            }

            const upstreamUrl = unified.url ?? unified.httpUrl;

            if (!upstreamUrl) {
                return jsonRpcError(`${name} has no upstream url`, 500);
            }

            const auth = serverAuth(unified);
            const resource = auth?.resource ?? upstreamUrl.replace(/\/+$/, "");
            const tokenEndpoint = auth?.tokenEndpoint;

            if (!tokenEndpoint) {
                return jsonRpcError(`tools mcp-manager auth login ${name}`);
            }

            let accessToken: string;

            try {
                accessToken = await accessTokenForRequest(name, {
                    tokenEndpoint,
                    resource,
                    allowRefresh: true,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn({ server: name, error }, "gateway could not obtain an upstream token");

                return jsonRpcError(message.includes("auth login") ? message : `tools mcp-manager auth login ${name}`);
            }

            const upstream = new URL(upstreamUrl);
            const target = new URL(upstream.toString());

            if (url.search) {
                target.search = url.search;
            }

            const headers = headersToUpstream(request, accessToken);
            const init: RequestInit = {
                method: request.method,
                headers,
                redirect: "manual",
            };

            if (request.method !== "GET" && request.method !== "HEAD") {
                init.body = await request.arrayBuffer();
            }

            let response = await fetch(target, init);

            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get("location");

                if (!location) {
                    return jsonRpcError("redirect without location", 502);
                }

                const next = new URL(location, target);

                if (next.origin !== upstream.origin) {
                    return jsonRpcError("refused off-origin redirect", 502);
                }

                response = await fetch(next, { ...init, redirect: "manual" });
            }

            return new Response(response.body, {
                status: response.status,
                headers: headersToClient(response.headers),
            });
        },
    });

    const boundPort = server.port;
    const boundHost = server.hostname;

    if (boundPort === undefined || boundHost === undefined) {
        server.stop(true);
        throw new Error("mcp gateway bound without a reachable address");
    }

    logger.info({ hostname: boundHost, port: boundPort }, "mcp gateway listening");

    return {
        port: boundPort,
        hostname: boundHost,
        url: gatewayServerUrl({ host: boundHost, port: boundPort }, "x").replace(/\/mcp\/x$/, ""),
        stop: () => server.stop(true),
    };
}
