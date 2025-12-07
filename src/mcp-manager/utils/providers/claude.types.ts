/**
 * Claude MCP server configuration
 */
export interface ClaudeMCPServerConfig {
    type?: string;
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;
    url?: string;
}

/**
 * Claude project configuration
 */
export interface ClaudeProjectConfig {
    mcpServers?: Record<string, ClaudeMCPServerConfig>;
    disabledMcpServers?: string[];
}

/**
 * Claude generic configuration
 */
export interface ClaudeGenericConfig {
    mcpServers?: Record<string, ClaudeMCPServerConfig>;
    disabledMcpServers?: string[];
    projects?: Record<string, ClaudeProjectConfig>;
}
