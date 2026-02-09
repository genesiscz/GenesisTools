import type {
    MCPServerInfo,
    UnifiedMCPConfig,
    UnifiedMCPServerConfig,
} from "@app/mcp-manager/utils/providers/types.js";
import { MCPProvider, WriteResult } from "@app/mcp-manager/utils/providers/types.js";

/**
 * Mock MCP Provider for testing
 */
export class MockMCPProvider extends MCPProvider {
    public configExistsResult: boolean = true;
    public readConfigResult: unknown = {};
    public listServersResult: MCPServerInfo[] = [];
    public getServerConfigResult: UnifiedMCPServerConfig | null = null;
    public getProjectsResult: string[] = [];
    public enableServerCalls: Array<{ serverName: string; projectPath?: string | null }> = [];
    public disableServerCalls: Array<{ serverName: string; projectPath?: string | null }> = [];
    public enableServersCalls: Array<{ serverNames: string[]; projectPath?: string | null }> = [];
    public disableServersCalls: Array<{ serverNames: string[]; projectPath?: string | null }> = [];
    public installServerCalls: Array<{ serverName: string; config: UnifiedMCPServerConfig }> = [];
    public syncServersCalls: Array<{ servers: Record<string, UnifiedMCPServerConfig> }> = [];
    public writeConfigCalls: unknown[] = [];
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

    supportsDisabledState(): boolean {
        return true; // Default mock behavior - can be overridden for testing
    }

    async readConfig(): Promise<unknown> {
        if (this.errors.has("readConfig")) {
            throw this.errors.get("readConfig")!;
        }
        return this.readConfigResult;
    }

    async writeConfig(config: unknown): Promise<WriteResult> {
        if (this.errors.has("writeConfig")) {
            throw this.errors.get("writeConfig")!;
        }
        this.writeConfigCalls.push(config);
        return WriteResult.Applied;
    }

    async listServers(): Promise<MCPServerInfo[]> {
        if (this.errors.has("listServers")) {
            throw this.errors.get("listServers")!;
        }
        return this.listServersResult;
    }

    async getServerConfig(_serverName: string): Promise<UnifiedMCPServerConfig | null> {
        if (this.errors.has("getServerConfig")) {
            throw this.errors.get("getServerConfig")!;
        }
        return this.getServerConfigResult;
    }

    async enableServer(serverName: string, projectPath?: string | null): Promise<void> {
        if (this.errors.has("enableServer")) {
            throw this.errors.get("enableServer")!;
        }
        this.enableServerCalls.push({ serverName, projectPath });
    }

    async disableServer(serverName: string, projectPath?: string | null): Promise<void> {
        if (this.errors.has("disableServer")) {
            throw this.errors.get("disableServer")!;
        }
        this.disableServerCalls.push({ serverName, projectPath });
    }

    async disableServerForAllProjects(_serverName: string): Promise<void> {
        if (this.errors.has("disableServerForAllProjects")) {
            throw this.errors.get("disableServerForAllProjects")!;
        }
    }

    async enableServers(serverNames: string[], projectPath?: string | null): Promise<WriteResult> {
        if (this.errors.has("enableServers")) {
            throw this.errors.get("enableServers")!;
        }
        this.enableServersCalls.push({ serverNames, projectPath });
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

    fromUnifiedConfig(_servers: Record<string, UnifiedMCPServerConfig>): unknown {
        return {};
    }

    isServerEnabledInMeta(serverConfig: UnifiedMCPServerConfig, projectPath?: string | null): boolean {
        const enabledState =
            serverConfig._meta?.enabled?.[this.providerName as keyof typeof serverConfig._meta.enabled];
        if (enabledState === undefined) {
            return false;
        }
        if (typeof enabledState === "boolean") {
            return enabledState;
        }
        if (projectPath === null || projectPath === undefined) {
            return false;
        }
        return enabledState[projectPath] === true;
    }

    reset(): void {
        this.configExistsResult = true;
        this.readConfigResult = {};
        this.listServersResult = [];
        this.getServerConfigResult = null;
        this.getProjectsResult = [];
        this.enableServerCalls = [];
        this.disableServerCalls = [];
        this.enableServersCalls = [];
        this.disableServersCalls = [];
        this.installServerCalls = [];
        this.syncServersCalls = [];
        this.writeConfigCalls = [];
        this.errors.clear();
    }
}

/**
 * Create a mock unified config
 */
export function createMockUnifiedConfig(): UnifiedMCPConfig {
    return {
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
export function createMockEnquirer(responses: Record<string, any> = {}) {
    class MockEnquirer {
        async prompt(promptConfig: any): Promise<any> {
            const responseKey = promptConfig.name || Object.keys(responses)[0];
            return responses[responseKey] || responses || {};
        }
    }

    return {
        default: MockEnquirer,
    };
}
