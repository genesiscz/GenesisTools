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
    abstract writeConfig(config: unknown): Promise<void>;

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
     * Enable multiple MCP servers in a single batch operation (one backup, one diff, one save)
     * @param serverNames - Names of the servers to enable
     * @param projectPath - Optional project path for project-specific enabling
     */
    abstract enableServers(serverNames: string[], projectPath?: string | null): Promise<void>;

    /**
     * Disable multiple MCP servers in a single batch operation (one backup, one diff, one save)
     * @param serverNames - Names of the servers to disable
     * @param projectPath - Optional project path for project-specific disabling
     */
    abstract disableServers(serverNames: string[], projectPath?: string | null): Promise<void>;

    /**
     * Get available projects (if provider supports project-level configuration)
     * @returns Array of project paths, or empty array if not supported
     */
    getProjects(): Promise<string[]> {
        // Default implementation returns empty array (no project support)
        return Promise.resolve([]);
    }

    /**
     * Install/add an MCP server configuration
     */
    abstract installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<void>;

    /**
     * Sync servers from unified config to this provider.
     * Reads _meta.enabled[providerName] to determine enabled state per server.
     * @param servers - Server configurations to sync (with _meta intact)
     */
    abstract syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<void>;

    /**
     * Convert provider-specific config to unified format
     */
    abstract toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig>;

    /**
     * Convert unified config to provider-specific format
     */
    abstract fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown;
}
