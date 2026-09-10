import type { McpAuthPolicy, McpServerAuth, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { CLIENT_NAME_DEFAULT } from "./constants.ts";

export function serverAuth(config: UnifiedMCPServerConfig | undefined): McpServerAuth | undefined {
    const auth = config?.auth;

    if (!auth || typeof auth !== "object") {
        return undefined;
    }

    if (auth.kind !== "oauth" && auth.kind !== "bearer" && auth.kind !== "none") {
        return undefined;
    }

    return auth;
}

export function isGatewayOauth(config: UnifiedMCPServerConfig | undefined): boolean {
    const auth = serverAuth(config);

    return Boolean(auth && auth.kind === "oauth" && auth.gateway);
}

export function clientNameFor(config: UnifiedMCPServerConfig): string {
    const auth = serverAuth(config);

    if (auth?.policy === "figma-client-name") {
        return auth.clientName ?? "Claude Code (genesis-tools)";
    }

    return auth?.clientName ?? CLIENT_NAME_DEFAULT;
}

export function policyFor(config: UnifiedMCPServerConfig): McpAuthPolicy {
    return serverAuth(config)?.policy ?? "open-dcr";
}
