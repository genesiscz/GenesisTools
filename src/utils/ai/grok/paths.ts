import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";

export function resolveGrokHome(): string {
    return env.grok.getHome() ?? join(homedir(), ".grok");
}

export function grokAuthPath(home?: string): string {
    return join(home ?? resolveGrokHome(), "auth.json");
}

export function grokModelsCachePath(home?: string): string {
    return join(home ?? resolveGrokHome(), "models_cache.json");
}

export function grokVersionPath(home?: string): string {
    return join(home ?? resolveGrokHome(), "version.json");
}

export function grokConfigPath(home?: string): string {
    return join(home ?? resolveGrokHome(), "config.json");
}

export const GROK_CLI_CHAT_PROXY_BASE_URL = env.x.getCliChatProxyBaseUrl() ?? "https://cli-chat-proxy.grok.com/v1";

export const GROK_MANAGEMENT_API_BASE_URL = env.x.getManagementApiBaseUrl() ?? "https://management-api.x.ai/v1";
