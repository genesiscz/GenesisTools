import { join } from "node:path";
import { Storage } from "@genesiscz/utils/storage";

function mcpStorage(): Storage {
    return new Storage("mcp-manager");
}

export function mcpManagerDir(): string {
    return mcpStorage().getBaseDir();
}

export function authStatusPath(): string {
    return join(mcpManagerDir(), "auth-status.json");
}

export function refreshLockPath(server: string): string {
    return join(mcpManagerDir(), "locks", `refresh-${encodeURIComponent(server)}.lock`);
}

export function gatewayPidPath(): string {
    return join(mcpManagerDir(), "gateway.pid");
}

export function secretPath(server: string, field: string): string {
    return `mcp/${server}/${field}`;
}

export const GATEWAY_CLIENT_TOKEN_PATH = "mcp/gateway/client-token";
