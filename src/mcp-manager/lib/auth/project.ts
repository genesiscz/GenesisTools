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
