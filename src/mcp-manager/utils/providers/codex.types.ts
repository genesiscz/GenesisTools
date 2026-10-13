/**
 * Codex generic configuration
 */
export interface CodexGenericConfig {
    model?: string;
    model_reasoning_effort?: "low" | "medium" | "high";
    show_raw_agent_reasoning?: boolean;
    mcp_servers?: Record<string, CodexMCPServerConfig>;
    projects?: Record<string, CodexProjectConfig>;
    plugins?: Record<string, CodexPluginConfig>;
    [key: string]: unknown;
}

/**
 * One `[plugins."<plugin>@<marketplace>"]` table. `mcp_servers` holds per-server overrides for the
 * MCP servers the plugin declares; `enabled = false` there makes Codex skip that server while the
 * plugin stays enabled.
 */
export interface CodexPluginConfig {
    enabled?: boolean;
    mcp_servers?: Record<string, CodexPluginMcpServerOverride>;
    [key: string]: unknown;
}

export interface CodexPluginMcpServerOverride {
    enabled?: boolean;
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
