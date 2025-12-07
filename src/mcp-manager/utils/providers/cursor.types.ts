/**
 * Cursor generic configuration
 */
export interface CursorGenericConfig {
    mcpServers?: Record<string, CursorMCPServerConfig>;
    [key: string]: unknown;
}

/**
 * Cursor MCP server configuration
 */
export interface CursorMCPServerConfig {
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;
    [key: string]: unknown;
}
