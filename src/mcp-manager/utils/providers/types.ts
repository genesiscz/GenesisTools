import type { MCPServerMeta, EnabledMcpServers } from "../types.js";

/**
 * Unified MCP server configuration interface.
 * Represents a server configuration that can be synced across providers.
 */
export interface UnifiedMCPServerConfig {
    // Transport identification
    type?: "stdio" | "sse" | "http";

    // STDIO transport (most common)
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;

    // HTTP/SSE transport
    url?: string;
    httpUrl?: string;
    headers?: Record<string, string>;

    /**
     * Meta information for this server.
     * This field is NOT synchronized to/from providers.
     * Contains enabled state per provider.
     */
    _meta?: MCPServerMeta;

    // Platform-specific extensions
    [key: string]: unknown;
}

/**
 * Unified MCP configuration schema for ~/mcp.json
 */
export interface UnifiedMCPConfig {
    mcpServers: Record<string, UnifiedMCPServerConfig>;
    /**
     * Enabled state for MCP servers per provider.
     * This is a duplicate of _meta.enabled information for easier access.
     * Maps server name to enabled state per provider.
     */
    enabledMcpServers?: EnabledMcpServers;
    [key: string]: unknown;
}

/**
 * Information about an MCP server including its status
 */
export interface MCPServerInfo {
    name: string;
    config: UnifiedMCPServerConfig;
    enabled: boolean;
    provider: string;
}

import { BackupManager } from "../backup.js";

/**
 * Base abstract class for MCP configuration providers.
 * Each provider (Claude, Gemini, Codex, Cursor) extends this class.
 */
export abstract class MCPProvider {
    protected configPath: string;
    protected providerName: string;
    protected backupManager: BackupManager;

    constructor(configPath: string, providerName: string) {
        this.configPath = configPath;
        this.providerName = providerName;
        this.backupManager = new BackupManager();
    }

    /**
     * Get the name of this provider
     */
    getName(): string {
        return this.providerName;
    }

    /**
     * Get the configuration file path
     */
    getConfigPath(): string {
        return this.configPath;
    }

    /**
     * Check if the configuration file exists
     */
    abstract configExists(): Promise<boolean>;

    /**
     * Read the configuration file
     */
    abstract readConfig(): Promise<unknown>;

    /**
     * Write the configuration file
     */
    abstract writeConfig(config: unknown): Promise<boolean>;

    /**
     * Get list of all MCP servers (enabled and disabled)
     */
    abstract listServers(): Promise<MCPServerInfo[]>;

    /**
     * Get full configuration of a specific MCP server
     */
    abstract getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null>;

    /**
     * Enable an MCP server
     * @param serverName - Name of the server to enable
     * @param projectPath - Optional project path for project-specific enabling (e.g., Claude projects)
     */
    abstract enableServer(serverName: string, projectPath?: string | null): Promise<void>;

    /**
     * Disable an MCP server
     * @param serverName - Name of the server to disable
     * @param projectPath - Optional project path for project-specific disabling (e.g., Claude projects)
     */
    abstract disableServer(serverName: string, projectPath?: string | null): Promise<void>;

    /**
     * Disable an MCP server for all projects (if applicable)
     */
    abstract disableServerForAllProjects(serverName: string): Promise<void>;

    /**
     * Enable multiple MCP servers in a single batch operation
     * @param serverNames - Names of the servers to enable
     * @param projectPath - Optional project path for project-specific enabling
     * @returns true if changes were applied, false if no changes or rejected
     */
    abstract enableServers(serverNames: string[], projectPath?: string | null): Promise<boolean>;

    /**
     * Disable multiple MCP servers in a single batch operation
     * @param serverNames - Names of the servers to disable
     * @param projectPath - Optional project path for project-specific disabling
     * @returns true if changes were applied, false if no changes or rejected
     */
    abstract disableServers(serverNames: string[], projectPath?: string | null): Promise<boolean>;

    /**
     * Get available projects (if provider supports project-level configuration)
     * @returns Array of project paths, or empty array if not supported
     */
    getProjects(): Promise<string[]> {
        // Default implementation returns empty array (no project support)
        return Promise.resolve([]);
    }

    /**
     * Get enabled state per project for all servers.
     * For providers with project support, returns a map of server names to their per-project enabled states.
     * For providers without project support, returns an empty map.
     * @returns Map of server name to per-project enabled states (project path -> boolean)
     */
    async getServerEnabledStatesPerProject(): Promise<Map<string, Record<string, boolean>>> {
        // Default implementation returns empty map (no project support)
        return Promise.resolve(new Map());
    }

    /**
     * Install/add an MCP server configuration
     * @returns true if changes were applied, false if reverted
     */
    abstract installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<boolean>;

    /**
     * Check if this provider supports a "disabled" state for servers.
     * - Claude/Gemini: true (have disabledMcpServers/mcp.excluded lists)
     * - Cursor/Codex: false (presence in config = enabled, no separate disabled state)
     */
    abstract supportsDisabledState(): boolean;

    /**
     * Check if a server is enabled for this provider based on _meta.enabled state.
     * For providers with project support, checks if enabled globally or for a specific project.
     * @param serverConfig - Server configuration with _meta
     * @param projectPath - Optional project path to check (for providers with project support)
     * @returns true if enabled, false otherwise
     */
    isServerEnabledInMeta(serverConfig: UnifiedMCPServerConfig, projectPath?: string | null): boolean {
        const providerName = this.providerName;
        const enabledState = serverConfig._meta?.enabled?.[providerName as keyof typeof serverConfig._meta.enabled];

        if (enabledState === undefined) {
            // Not explicitly set - default to disabled
            return false;
        }

        if (typeof enabledState === "boolean") {
            // Simple boolean - global enablement
            return enabledState;
        }

        // Per-project enablement object
        if (projectPath === null || projectPath === undefined) {
            // Check if enabled globally (any project has it enabled, or check for global key)
            // For now, if it's an object, we consider it project-specific and not globally enabled
            return false;
        }

        // Check specific project
        return enabledState[projectPath] === true;
    }

    /**
     * Sync servers from unified config to this provider.
     * Reads _meta.enabled[providerName] to determine enabled state per server.
     * @param servers - Server configurations to sync (with _meta intact)
     * @returns true if changes were applied, false if no changes or rejected
     */
    abstract syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<boolean>;

    /**
     * Convert provider-specific config to unified format
     */
    abstract toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig>;

    /**
     * Convert unified config to provider-specific format
     */
    abstract fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown;
}
