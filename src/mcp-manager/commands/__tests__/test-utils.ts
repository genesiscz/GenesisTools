import type {
    EnableServersOptions,
    MCPServerInfo,
    UnifiedMCPConfig,
    UnifiedMCPServerConfig,
} from "@app/mcp-manager/utils/providers/types.js";
import { MCPProvider, WriteResult } from "@app/mcp-manager/utils/providers/types.js";

/**
 * Mock MCP Provider for testing: the ten abstract members, plus the optional hooks the command tests drive.
 */
export class MockMCPProvider extends MCPProvider {
    public configExistsResult: boolean = true;
    public readConfigResult: unknown = {};
    public listServersResult: MCPServerInfo[] = [];
    public listPluginServersResult: MCPServerInfo[] = [];
    public getServerConfigResult: UnifiedMCPServerConfig | null = null;
    public getProjectsResult: string[] = [];
    public enableServersCalls: Array<{
        serverNames: string[];
        projectPath?: string | null;
        options?: EnableServersOptions;
    }> = [];
    public disableServersCalls: Array<{ serverNames: string[]; projectPath?: string | null }> = [];
    public installServerCalls: Array<{ serverName: string; config: UnifiedMCPServerConfig }> = [];
    public removeServersCalls: Array<{ serverNames: string[] }> = [];
    public syncServersCalls: Array<{ servers: Record<string, UnifiedMCPServerConfig> }> = [];
    public errors: Map<string, Error> = new Map();

    constructor(providerName: string, configPath: string = `/mock/${providerName}.json`) {
        super(configPath, providerName);
    }

    async configExists(): Promise<boolean> {
        if (this.errors.has("configExists")) {
            throw this.errors.get("configExists")!;
        }
        return this.configExistsResult;
    }

    async readConfig(): Promise<unknown> {
        if (this.errors.has("readConfig")) {
            throw this.errors.get("readConfig")!;
        }
        return this.readConfigResult;
    }

    async listServers(): Promise<MCPServerInfo[]> {
        if (this.errors.has("listServers")) {
            throw this.errors.get("listServers")!;
        }
        return this.listServersResult;
    }

    async listPluginServers(): Promise<MCPServerInfo[]> {
        return this.listPluginServersResult;
    }

    async getServerConfig(_serverName: string): Promise<UnifiedMCPServerConfig | null> {
        if (this.errors.has("getServerConfig")) {
            throw this.errors.get("getServerConfig")!;
        }
        return this.getServerConfigResult;
    }

    async enableServers(
        serverNames: string[],
        projectPath?: string | null,
        options?: EnableServersOptions
    ): Promise<WriteResult> {
        if (this.errors.has("enableServers")) {
            throw this.errors.get("enableServers")!;
        }
        this.enableServersCalls.push({ serverNames, projectPath, options });
        return WriteResult.Applied;
    }

    async disableServers(serverNames: string[], projectPath?: string | null): Promise<WriteResult> {
        if (this.errors.has("disableServers")) {
            throw this.errors.get("disableServers")!;
        }
        this.disableServersCalls.push({ serverNames, projectPath });
        return WriteResult.Applied;
    }

    async getProjects(): Promise<string[]> {
        if (this.errors.has("getProjects")) {
            throw this.errors.get("getProjects")!;
        }
        return this.getProjectsResult;
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<WriteResult> {
        if (this.errors.has("installServer")) {
            throw this.errors.get("installServer")!;
        }
        this.installServerCalls.push({ serverName, config });
        return WriteResult.Applied;
    }

    async removeServers(serverNames: string[]): Promise<WriteResult> {
        if (this.errors.has("removeServers")) {
            throw this.errors.get("removeServers")!;
        }
        // Copy — capturing the live reference would let later caller-side
        // mutation rewrite recorded history.
        this.removeServersCalls.push({ serverNames: [...serverNames] });
        return WriteResult.Applied;
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult> {
        if (this.errors.has("syncServers")) {
            throw this.errors.get("syncServers")!;
        }
        this.syncServersCalls.push({ servers });
        return WriteResult.Applied;
    }

    toUnifiedConfig(_config: unknown): Record<string, UnifiedMCPServerConfig> {
        return {};
    }

    reset(): void {
        this.configExistsResult = true;
        this.readConfigResult = {};
        this.listServersResult = [];
        this.listPluginServersResult = [];
        this.getServerConfigResult = null;
        this.getProjectsResult = [];
        this.enableServersCalls = [];
        this.disableServersCalls = [];
        this.installServerCalls = [];
        this.removeServersCalls = [];
        this.syncServersCalls = [];
        this.errors.clear();
    }
}

/**
 * Create a mock unified config
 */
export function createMockUnifiedConfig(): UnifiedMCPConfig {
    return {
        harnesses: {
            claude: {
                syncTo: { homes: ["~/.claude.json"] },
                syncFrom: { homes: ["~/.claude.json"] },
            },
            gemini: {
                syncTo: { homes: ["~/.gemini/settings.json"] },
                syncFrom: { homes: ["~/.gemini/settings.json"] },
            },
            cursor: {
                syncTo: { homes: ["~/.cursor/mcp.json"] },
                syncFrom: { homes: ["~/.cursor/mcp.json"] },
            },
            codex: {
                syncTo: { homes: ["~/.codex"] },
                syncFrom: { homes: ["~/.codex"] },
            },
        },
        mcpServers: {
            "test-server": {
                command: "test-command",
                args: ["arg1", "arg2"],
                env: { TEST_ENV: "value" },
                _meta: {
                    enabled: {
                        claude: true,
                        gemini: false,
                    },
                },
            },
            "another-server": {
                command: "another-command",
                _meta: {
                    enabled: {
                        claude: false,
                    },
                },
            },
        },
    };
}

/**
 * Create a mock server config
 */
export function createMockServerConfig(name: string = "test-server"): UnifiedMCPServerConfig {
    return {
        command: `${name}-command`,
        args: ["arg1"],
        _meta: {
            enabled: {
                claude: true,
            },
        },
    };
}

/**
 * Create a mock Enquirer class that can be used with mock.module()
 */
export function createMockEnquirer(responses: Record<string, unknown> = {}) {
    class MockEnquirer {
        async prompt(promptConfig: Record<string, unknown>): Promise<unknown> {
            const responseKey = (promptConfig.name as string) || Object.keys(responses)[0];
            return responses[responseKey] || responses || {};
        }
    }

    return {
        default: MockEnquirer,
    };
}
