import type { UnifiedMCPConfig, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GATEWAY_HEADER } from "../auth/constants.ts";
import { isGatewayOauth, serverAuth } from "../auth/policy.ts";
import { gatewayBaseUrl, gatewayListen } from "../auth/project.ts";
import { ensureGatewayClientToken } from "../auth/secrets.ts";
import { accessTokenForRequest } from "../auth/tokens.ts";
import { autoLoginRefusal, type LoginLauncher } from "./auto-login.ts";
import { headersToClient, headersToUpstream, localTokenMatches, loopbackHostOk } from "./headers.ts";
import { gatewayLoginLauncher } from "./login-runner.ts";

export interface GatewayHandle {
    port: number;
    hostname: string;
    url: string;
    stop(): void;
    /**
     * Stop the listener from holding the event loop open. `gateway start` wants the
     * opposite and never calls this; a command that merely needed a gateway to exist
     * (`auth login`, `scripts run`, the stdio trampoline) calls it so the process can
     * exit when its real work is done. See ensureGatewayUp.
     */
    unref(): void;
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

/**
 * Answer a request that cannot be served because the server has no usable token, and
 * start the login that fixes it.
 *
 * The client is told what is happening rather than what to type: a harness that offers
 * its own "Authenticate" button cannot use it here, because that button registers an
 * OAuth client against the GATEWAY's origin, which serves no metadata and answers 404.
 */
function loginRequiredResponse(name: string, server: UnifiedMCPServerConfig, launcher: LoginLauncher): Response {
    const refusal = autoLoginRefusal(name, server);

    if (refusal) {
        logger.info({ server: name }, "gateway skipped auto-login that cannot finish unattended");

        return jsonRpcError(refusal);
    }

    const outcome = launcher.request(name);
    logger.info({ server: name, outcome }, "gateway requested an MCP login");

    const url = launcher.authorizationUrl(name);
    const userCode = launcher.userCode(name);
    const link = url ? ` Reopen it here: ${url}` : "";
    const code = userCode ? ` Enter code ${userCode}.` : "";

    if (outcome === "cooling-down") {
        return jsonRpcError(
            `${name} needs a login and the last attempt failed. Run tools mcp-manager auth login ${name}${link}${code}`
        );
    }

    const lead = outcome === "started" ? "a browser window is opening" : "a browser window is already open";
    // The first response is answered before the login has built its URL. A stale
    // authorize link from a previous success must not be echoed here.
    const extras = outcome === "started" ? "" : `${link}${code}`;

    return jsonRpcError(`${name} needs a login: ${lead}. Authorize it, then reconnect this server.${extras}`);
}

function serverNameFromPath(pathname: string): string | undefined {
    const match = pathname.match(/^\/mcp\/([^/]+)\/?$/);

    if (!match?.[1]) {
        return undefined;
    }

    return decodeURIComponent(match[1]);
}

const LOOPBACK_BIND_HOSTS = new Set(["localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);

/** Bind-address form, not the Host-header form: no port, and IPv6 may arrive bare. */
export function isLoopbackBindHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();

    if (LOOPBACK_BIND_HOSTS.has(normalized)) {
        return true;
    }

    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export async function startGatewayServer(
    config: UnifiedMCPConfig,
    opts: {
        port?: number;
        hostname?: string;
        readConfig?: () => Promise<UnifiedMCPConfig>;
        loginLauncher?: LoginLauncher;
    } = {}
): Promise<GatewayHandle> {
    const listen = gatewayListen(config);
    const hostname = opts.hostname ?? listen.host;
    const port = opts.port ?? listen.port;
    const launcher = opts.loginLauncher ?? gatewayLoginLauncher;

    // loopbackHostOk only inspects the request's Host header, which any LAN client can
    // forge. The bind address is the real boundary: a gateway.listen.host of 0.0.0.0
    // publishes every stored OAuth token to the network behind one guessable header.
    if (!isLoopbackBindHost(hostname)) {
        throw new Error(
            `refusing to bind the mcp gateway to ${hostname}: gateway.listen.host must be a loopback address`
        );
    }

    let localToken = await ensureGatewayClientToken();

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
                // Re-read once before rejecting. This value was read at startup, so a
                // `gateway rotate-client` in another process used to be invisible here
                // for the lifetime of the server: every harness 401'd until someone
                // killed the process by hand, and `gateway stop` could not do it.
                // The happy path still costs no vault read.
                localToken = await ensureGatewayClientToken();

                if (!localTokenMatches(request, localToken)) {
                    return jsonRpcError(`missing ${GATEWAY_HEADER}. Run tools mcp-manager auth login ${name}`);
                }
            }

            const live = opts.readConfig ? await opts.readConfig() : config;
            const unified = live.mcpServers[name];

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
                return loginRequiredResponse(name, unified, launcher);
            }

            let accessToken: string;

            try {
                accessToken = await accessTokenForRequest(name, {
                    tokenEndpoint,
                    resource,
                    allowRefresh: true,
                });
            } catch (error) {
                logger.warn({ server: name, error }, "gateway could not obtain an upstream token");

                return loginRequiredResponse(name, unified, launcher);
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
                // MCP clients hold text/event-stream responses open for minutes. Without
                // this the upstream request outlives a client that hung up, and the
                // connection sits there until the far end closes it.
                signal: request.signal,
            };

            if (request.method !== "GET" && request.method !== "HEAD") {
                init.body = await request.arrayBuffer();
            }

            let current = target;
            let response = await fetch(current, init);
            let hops = 0;

            while (response.status >= 300 && response.status < 400) {
                hops += 1;

                if (hops > 5) {
                    return jsonRpcError("too many redirects", 502);
                }

                const location = response.headers.get("location");

                if (!location) {
                    return jsonRpcError("redirect without location", 502);
                }

                const next = new URL(location, current);

                if (next.origin !== upstream.origin) {
                    return jsonRpcError("refused off-origin redirect", 502);
                }

                current = next;
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
        url: gatewayBaseUrl({ host: boundHost, port: boundPort }),
        stop: () => server.stop(true),
        unref: () => server.unref(),
    };
}
