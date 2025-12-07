/**
 * Codex generic configuration
 */
export interface CodexGenericConfig {
    model?: string;
    model_reasoning_effort?: "low" | "medium" | "high";
    show_raw_agent_reasoning?: boolean;
    mcp_servers?: Record<string, CodexMCPServerConfig>;
    projects?: Record<string, CodexProjectConfig>;
    [key: string]: unknown;
}

/**
 * Codex MCP server configuration
 */
export interface CodexMCPServerConfig {
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;
    [key: string]: unknown;
}

/**
 * Codex project configuration
 */
export interface CodexProjectConfig {
    trust_level?: "trusted" | "untrusted" | "unknown";
    [key: string]: unknown;
}
