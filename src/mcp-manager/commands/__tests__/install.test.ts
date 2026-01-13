import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { installServer } from "../install.js";
import { MockMCPProvider, createMockUnifiedConfig, createMockServerConfig } from "./test-utils.js";
import * as configUtils from "../../utils/config.utils.js";
import logger from "@app/logger";

describe("installServer", () => {
    let mockProvider: MockMCPProvider;
    let mockProviders: MockMCPProvider[];

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProviders = [mockProvider];
    });

    it("should install server with provided name and command", async () => {
        const mockConfig = createMockUnifiedConfig();
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");
        spyOn(logger, "warn");
        
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async () => ({
                selectedProvider: "claude",
            }),
        }));

        await installServer("new-server", 'npx -y @modelcontextprotocol/server-github', mockProviders);

        expect(mockProvider.installServerCalls.length).toBe(1);
        expect(mockProvider.installServerCalls[0].serverName).toBe("new-server");
        expect(configUtils.writeUnifiedConfig).toHaveBeenCalled();
    });

    it("should prompt for server name if not provided", async () => {
        const mockConfig = createMockUnifiedConfig();
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");
        spyOn(logger, "warn");
        
        let promptCallCount = 0;
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async (promptConfig: any) => {
                promptCallCount++;
                if (promptConfig.name === "inputServerName") {
                    return { inputServerName: "prompted-server" };
                }
                if (promptConfig.name === "inputCommand") {
                    return { inputCommand: "test-command" };
                }
                if (promptConfig.name === "inputEnv") {
                    return { inputEnv: "" };
                }
                if (promptConfig.name === "selectedProvider") {
                    return { selectedProvider: "claude" };
                }
                return {};
            },
        }));

        await installServer(undefined, undefined, mockProviders);

        expect(promptCallCount).toBeGreaterThan(0);
        expect(mockProvider.installServerCalls.length).toBe(1);
    });

    it("should prompt for command if server exists but command provided", async () => {
        const mockConfig = createMockUnifiedConfig();
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");
        
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async () => ({
                selectedProvider: "claude",
            }),
        }));

        await installServer("test-server", 'npx -y @modelcontextprotocol/server-github', mockProviders);

        expect(mockProvider.installServerCalls.length).toBe(1);
    });

    it("should parse ENV variables correctly", async () => {
        const mockConfig = createMockUnifiedConfig();
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");
        
        let promptCallCount = 0;
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async (promptConfig: any) => {
                promptCallCount++;
                if (promptConfig.name === "inputEnv") {
                    return { inputEnv: "KEY1=value1 KEY2=value2" };
                }
                if (promptConfig.name === "selectedProvider") {
                    return { selectedProvider: "claude" };
                }
                return {};
            },
        }));

        await installServer("new-server", "test-command", mockProviders);

        const writeCall = (configUtils.writeUnifiedConfig as any).mock.calls[0][0];
        const serverConfig = writeCall.mcpServers["new-server"];
        expect(serverConfig.env).toBeDefined();
        expect(serverConfig.env.KEY1).toBe("value1");
        expect(serverConfig.env.KEY2).toBe("value2");
    });

    it("should return early if no providers available", async () => {
        const mockConfig = createMockUnifiedConfig();
        mockProvider.configExistsResult = false;
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "warn");
        
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async () => ({
                selectedProvider: "claude",
            }),
        }));

        await installServer("new-server", "test-command", mockProviders);

        expect(logger.warn).toHaveBeenCalledWith("No provider configuration files found.");
    });

    it("should handle command parsing errors", async () => {
        const mockConfig = createMockUnifiedConfig();
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "error");
        
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async () => ({
                inputCommand: "", // Empty command should cause error
            }),
        }));

        await installServer("new-server", undefined, mockProviders);

        // Should handle empty command gracefully
        expect(logger.error).toHaveBeenCalled();
    });
});




