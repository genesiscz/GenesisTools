/**
 * Gemini Code Assist generic configuration
 */
export interface GeminiGenericConfig {
    mcp?: {
        excluded?: string[];
        [key: string]: unknown;
    };
    mcpServers?: Record<string, GeminiMCPServerConfig>;
    [key: string]: unknown;
}

/**
 * Gemini MCP server configuration
 * Note: Gemini CLI uses mcp.excluded array to disable servers, not a disabled property
 */
export interface GeminiMCPServerConfig {
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;
    url?: string;
    httpUrl?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
}
