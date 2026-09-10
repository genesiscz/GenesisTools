export interface GrokMCPServerConfig {
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    enabled?: boolean;
    [key: string]: unknown;
}

export interface GrokGenericConfig {
    mcp_servers?: Record<string, GrokMCPServerConfig>;
    [key: string]: unknown;
}
