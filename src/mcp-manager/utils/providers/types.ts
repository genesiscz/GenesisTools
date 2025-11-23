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

    // State management
    enabled?: boolean;
    disabled?: boolean;

    // Platform-specific extensions
    [key: string]: unknown;
}

/**
 * Unified MCP configuration schema for ~/mcp.json
 */
export interface UnifiedMCPConfig {
    mcpServers: Record<string, UnifiedMCPServerConfig>;
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
     */
    abstract enableServer(serverName: string): Promise<void>;

    /**
     * Disable an MCP server
     */
    abstract disableServer(serverName: string): Promise<void>;

    /**
     * Disable an MCP server for all projects (if applicable)
     */
    abstract disableServerForAllProjects(serverName: string): Promise<void>;

    /**
     * Install/add an MCP server configuration
     */
    abstract installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<void>;

    /**
     * Sync servers from unified config to this provider
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
