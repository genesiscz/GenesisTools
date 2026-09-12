import type { UnifiedMCPConfig, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import type { MCPProviderName } from "@app/mcp-manager/utils/types.js";
import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT, GATEWAY_HEADER } from "./constants.ts";
import { isGatewayOauth } from "./policy.ts";

export interface GatewayListen {
    host: string;
    port: number;
}

export function gatewayListen(config: UnifiedMCPConfig): GatewayListen {
    return {
        host: config.gateway?.listen?.host ?? DEFAULT_GATEWAY_HOST,
        port: config.gateway?.listen?.port ?? DEFAULT_GATEWAY_PORT,
    };
}

export function gatewayBaseUrl(listen: GatewayListen): string {
    return `http://${listen.host}:${listen.port}`;
}

export function gatewayServerUrl(listen: GatewayListen, server: string): string {
    return `${gatewayBaseUrl(listen)}/mcp/${encodeURIComponent(server)}`;
}

export function isGatewayProjectedUrl(url: string | undefined, listen: GatewayListen, server: string): boolean {
    if (!url) {
        return false;
    }

    try {
        const got = new URL(url);
        const expected = new URL(gatewayServerUrl(listen, server));

        return (
            got.origin === expected.origin && got.pathname.replace(/\/+$/, "") === expected.pathname.replace(/\/+$/, "")
        );
    } catch {
        return url === gatewayServerUrl(listen, server);
    }
}

/**
 * True when `config` is Cursor's gateway trampoline for this server. It carries no
 * `url` at all, which is why a url-only check never recognised it.
 */
export function isGatewayProjectedStdio(config: UnifiedMCPServerConfig, server: string): boolean {
    if (config.command !== "tools") {
        return false;
    }

    const args = config.args ?? [];
    const expected = ["mcp-manager", "gateway", "stdio", "--server", server];

    return expected.every((value, index) => args[index] === value);
}

/**
 * True when `config` is anything projectServerForHarness would have written for this
 * server: the http form (gateway url plus the local token header) or Cursor's stdio
 * trampoline. Use this, not isGatewayProjectedUrl, whenever the question is "did WE
 * write this?" — a url-only test answers `false` for every Cursor server.
 */
export function isGatewayProjection(config: UnifiedMCPServerConfig, listen: GatewayListen, server: string): boolean {
    const url = typeof config.url === "string" ? config.url : undefined;

    return isGatewayProjectedUrl(url, listen, server) || isGatewayProjectedStdio(config, server);
}

/**
 * Put the stored remote definition back over a projection, in place.
 *
 * Wholesale, not field by field: the two projection shapes carry different keys, so
 * restoring `url`/`httpUrl` alone leaves Cursor's `command` and `args` sitting on top
 * of the restored url, and drops `auth` (tokenEndpoint, resource) every time, because
 * projectServerForHarness never emits it. A dropped `auth` degrades the server to
 * "run auth login" on the next gateway start.
 *
 * `_meta` is never part of a projection round trip; the caller owns it.
 */
export function restoreProjectedServer(projected: UnifiedMCPServerConfig, stored: UnifiedMCPServerConfig): void {
    for (const key of Object.keys(projected)) {
        if (key !== "_meta") {
            delete (projected as Record<string, unknown>)[key];
        }
    }

    for (const [key, value] of Object.entries(stored)) {
        if (key !== "_meta") {
            (projected as Record<string, unknown>)[key] = value;
        }
    }
}

export function projectServerForHarness(
    name: string,
    config: UnifiedMCPServerConfig,
    opts: { provider: MCPProviderName; localToken: string; listen: GatewayListen }
): UnifiedMCPServerConfig {
    if (!isGatewayOauth(config)) {
        const { auth: _auth, ...rest } = config;

        return rest;
    }

    if (opts.provider === "cursor") {
        return {
            type: "stdio",
            command: "tools",
            args: ["mcp-manager", "gateway", "stdio", "--server", name],
            _meta: config._meta,
        };
    }

    return {
        type: "http",
        url: gatewayServerUrl(opts.listen, name),
        headers: { [GATEWAY_HEADER]: opts.localToken },
        _meta: config._meta,
    };
}

export function projectAllForHarness(
    servers: Record<string, UnifiedMCPServerConfig>,
    opts: { provider: MCPProviderName; localToken: string; listen: GatewayListen }
): Record<string, UnifiedMCPServerConfig> {
    const out: Record<string, UnifiedMCPServerConfig> = {};

    for (const [name, config] of Object.entries(servers)) {
        out[name] = projectServerForHarness(name, config, opts);
    }

    return out;
}
