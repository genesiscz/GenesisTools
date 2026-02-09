/**
 * Provider names that can be used for enabling/disabling MCP servers
 */
export type MCPProviderName = "claude" | "gemini" | "codex" | "cursor";

/**
 * Per-project enabled state for providers that support project-specific configuration (e.g., Claude)
 * Maps project path to enabled/disabled state
 */
export type PerProjectEnabledState = Record<string, boolean>;

/**
 * Enabled state for a provider.
 * Can be:
 * - boolean: Global enabled/disabled state (for providers without project support)
 * - PerProjectEnabledState: Per-project enabled state (for providers with project support like Claude)
 */
export type ProviderEnabledState = boolean | PerProjectEnabledState;

/**
 * Enabled state for a single MCP server across providers
 * Maps provider name to enabled/disabled state (boolean or per-project object)
 */
export type EnabledState = Partial<Record<MCPProviderName, ProviderEnabledState>>;

/**
 * Meta information for an MCP server configuration.
 * This field is NOT synchronized and is kept local to the unified config.
 */
export interface MCPServerMeta {
    /**
     * Enabled state per provider for this server.
     * This is NOT synchronized to/from providers.
     * For providers with project support (e.g., Claude), this can be an object mapping project paths to boolean values.
     */
    enabled: Partial<EnabledState>;
}

/**
 * Enabled MCP servers configuration at the root level.
 * Maps server name to its enabled state per provider.
 * This is a duplicate of the _meta.enabled information for easier access.
 */
export type EnabledMcpServers = Record<string, Partial<EnabledState>>;
