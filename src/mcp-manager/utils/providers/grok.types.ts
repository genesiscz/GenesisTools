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
    /** Server names Grok never starts, whether or not they have an `[mcp_servers]` table. */
    disabled_mcp_servers?: string[];
    [key: string]: unknown;
}
