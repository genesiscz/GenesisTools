import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { renameServer } from "../rename.js";
import { MockMCPProvider, createMockUnifiedConfig } from "./test-utils.js";
import * as configUtils from "../../utils/config.utils.js";
import logger from "@app/logger";

describe("renameServer", () => {
    let mockProvider: MockMCPProvider;
    let mockProviders: MockMCPProvider[];

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProviders = [mockProvider];
    });

    it("should rename server in unified config and providers", async () => {
        const mockConfig = createMockUnifiedConfig();
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue();
        spyOn(logger, "info");
        spyOn(logger, "warn");
        spyOn(logger, "error");
        
        let promptCallCount = 0;
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async (promptConfig: any) => {
                promptCallCount++;
                if (promptConfig.name === "selectedOldName") {
                    return { selectedOldName: "test-server" };
                }
                if (promptConfig.name === "inputNewName") {
                    return { inputNewName: "renamed-server" };
                }
                if (promptConfig.name === "selectedProviders") {
                    return { selectedProviders: ["claude"] };
                }
                return {};
            },
        }));

        await renameServer(undefined, undefined, mockProviders);

        expect(configUtils.writeUnifiedConfig).toHaveBeenCalled();
        const writeCall = (configUtils.writeUnifiedConfig as any).mock.calls[0][0];
        expect(writeCall.mcpServers["renamed-server"]).toBeDefined();
        expect(writeCall.mcpServers["test-server"]).toBeUndefined();
    });

    it("should handle conflict when new name already exists", async () => {
        const mockConfig = createMockUnifiedConfig();
        mockConfig.mcpServers["existing-server"] = createMockUnifiedConfig().mcpServers["test-server"];
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue();
        spyOn(logger, "info");
        spyOn(logger, "warn");
        
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async (promptConfig: any) => {
                if (promptConfig.name === "selectedOldName") {
                    return { selectedOldName: "test-server" };
                }
                if (promptConfig.name === "inputNewName") {
                    return { inputNewName: "existing-server" };
                }
                if (promptConfig.name === "confirmed") {
                    return { confirmed: true };
                }
                if (promptConfig.name === "selectedProviders") {
                    return { selectedProviders: ["claude"] };
                }
                return {};
            },
        }));

        await renameServer("test-server", "existing-server", mockProviders);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Conflict detected"));
    });

    it("should return early if old name not found", async () => {
        const mockConfig = createMockUnifiedConfig();
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "error");
        
        await renameServer("non-existent", "new-name", mockProviders);

        expect(logger.error).toHaveBeenCalledWith(
            "Server 'non-existent' not found in unified config."
        );
    });

    it("should return early if old and new names are the same", async () => {
        const mockConfig = createMockUnifiedConfig();
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "warn");

        await renameServer("test-server", "test-server", mockProviders);

        expect(logger.warn).toHaveBeenCalledWith(
            "Old name and new name are the same. No changes needed."
        );
    });

    it("should handle provider conflicts", async () => {
        const mockConfig = createMockUnifiedConfig();
        const mockServerInfo = {
            name: "existing-server",
            config: { command: "existing-command" },
            enabled: true,
            provider: "claude",
        };
        mockProvider.listServersResult = [mockServerInfo];
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue();
        spyOn(logger, "info");
        spyOn(logger, "warn");
        
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async (promptConfig: any) => {
                if (promptConfig.name === "selectedProviders") {
                    return { selectedProviders: ["claude"] };
                }
                if (promptConfig.name === "confirmed") {
                    return { confirmed: true };
                }
                return {};
            },
        }));

        await renameServer("test-server", "existing-server", mockProviders);

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Conflict in claude")
        );
    });

    it("should update enabledMcpServers when renaming", async () => {
        const mockConfig = createMockUnifiedConfig();
        mockConfig.enabledMcpServers = {
            "test-server": { claude: true },
        };
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue();
        spyOn(logger, "info");
        
        const mockPrompt = spyOn(require("enquirer"), "default").mockImplementation(() => ({
            prompt: async () => ({
                selectedProviders: ["claude"],
            }),
        }));

        await renameServer("test-server", "renamed-server", mockProviders);

        const writeCall = (configUtils.writeUnifiedConfig as any).mock.calls[0][0];
        expect(writeCall.enabledMcpServers["renamed-server"]).toBeDefined();
        expect(writeCall.enabledMcpServers["test-server"]).toBeUndefined();
    });
});




