/**
 * Provider names that can be used for enabling/disabling MCP servers
 */
export type MCPProviderName = "claude" | "gemini" | "codex" | "cursor";

/**
 * Enabled state for a single MCP server across providers
 * Maps provider name to enabled/disabled state
 */
export type EnabledState = Record<MCPProviderName, boolean>;

/**
 * Meta information for an MCP server configuration.
 * This field is NOT synchronized and is kept local to the unified config.
 */
export interface MCPServerMeta {
    /**
     * Enabled state per provider for this server.
     * This is NOT synchronized to/from providers.
     */
    enabled: Partial<EnabledState>;
}

/**
 * Enabled MCP servers configuration at the root level.
 * Maps server name to its enabled state per provider.
 * This is a duplicate of the _meta.enabled information for easier access.
 */
export type EnabledMcpServers = Record<string, Partial<EnabledState>>;

