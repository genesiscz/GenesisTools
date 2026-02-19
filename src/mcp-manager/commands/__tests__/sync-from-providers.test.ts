import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setMockResponses, setupInquirerMock } from "./inquirer-mock.js";

// Setup @inquirer/prompts mock BEFORE importing command modules
setupInquirerMock();

// Now import after mocking
const { syncFromProviders } = await import("../sync-from-providers.js");

import logger from "@app/logger";
import * as configUtils from "@app/mcp-manager/utils/config.utils.js";
import type { MCPServerInfo } from "@app/mcp-manager/utils/providers/types.js";
import { createMockServerConfig, createMockUnifiedConfig, MockMCPProvider } from "./test-utils.js";

describe("syncFromProviders", () => {
    let mockProvider: MockMCPProvider;

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");

        // Set default mock responses
        setMockResponses({
            selectedProviders: ["claude"],
        });
    });

    it("should sync servers from providers to unified config", async () => {
        const mockConfig = createMockUnifiedConfig();
        const mockServerInfo: MCPServerInfo = {
            name: "provider-server",
            config: createMockServerConfig("provider-server"),
            enabled: true,
            provider: "claude",
        };
        mockProvider.listServersResult = [mockServerInfo];

        let capturedConfig: any = null;
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockImplementation(async (config: any): Promise<boolean> => {
            capturedConfig = config;
            return true;
        });
        spyOn(logger, "info");
        spyOn(logger, "debug");
        spyOn(logger, "warn");

        setMockResponses({
            selectedProviders: ["claude"],
        });

        await syncFromProviders([mockProvider]);

        expect(configUtils.writeUnifiedConfig).toHaveBeenCalled();
        expect(capturedConfig).not.toBeNull();
        expect(capturedConfig.mcpServers["provider-server"]).toBeDefined();
    });

    it("should handle per-project enablement from Claude", async () => {
        const mockConfig = createMockUnifiedConfig();
        const mockServerInfo1: MCPServerInfo = {
            name: "project-server",
            config: createMockServerConfig("project-server"),
            enabled: true,
            provider: "claude:/path/to/project1",
        };
        const mockServerInfo2: MCPServerInfo = {
            name: "project-server",
            config: createMockServerConfig("project-server"),
            enabled: false,
            provider: "claude:/path/to/project2",
        };
        mockProvider.listServersResult = [mockServerInfo1, mockServerInfo2];
        // Provider needs to return projects to trigger per-project enablement
        mockProvider.getProjectsResult = ["/path/to/project1", "/path/to/project2"];

        let capturedConfig: any = null;
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockImplementation(async (config: any): Promise<boolean> => {
            capturedConfig = config;
            return true;
        });
        spyOn(logger, "info");
        spyOn(logger, "debug");

        setMockResponses({
            selectedProviders: ["claude"],
        });

        await syncFromProviders([mockProvider]);

        expect(capturedConfig).not.toBeNull();
        const enabledState = capturedConfig.mcpServers["project-server"]._meta.enabled.claude;
        expect(typeof enabledState).toBe("object");
        expect(enabledState["/path/to/project1"]).toBe(true);
        expect(enabledState["/path/to/project2"]).toBe(false);
    });

    it("should detect and handle conflicts", async () => {
        const mockConfig = createMockUnifiedConfig();
        const existingServer = createMockServerConfig("test-server");
        existingServer.command = "old-command";
        mockConfig.mcpServers["test-server"] = existingServer;

        const conflictingServer: MCPServerInfo = {
            name: "test-server",
            config: { command: "new-command", args: ["new-arg"] },
            enabled: true,
            provider: "claude",
        };
        mockProvider.listServersResult = [conflictingServer];

        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(logger, "info");
        spyOn(logger, "warn");

        setMockResponses({
            selectedProviders: ["claude"],
            choice: "current",
        });

        await syncFromProviders([mockProvider]);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Conflict detected"));
    });

    it("should merge enabled state when resolving conflicts", async () => {
        const mockConfig = createMockUnifiedConfig();
        const existingServer = createMockServerConfig("test-server");
        existingServer._meta?.enabled!.gemini = true;
        mockConfig.mcpServers["test-server"] = existingServer;

        const conflictingServer: MCPServerInfo = {
            name: "test-server",
            config: { command: "new-command" },
            enabled: true,
            provider: "claude",
        };
        mockProvider.listServersResult = [conflictingServer];

        let capturedConfig: any = null;
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockImplementation(async (config: any): Promise<boolean> => {
            capturedConfig = config;
            return true;
        });
        spyOn(logger, "info");
        spyOn(logger, "warn");

        setMockResponses({
            selectedProviders: ["claude"],
            choice: "incoming",
        });

        await syncFromProviders([mockProvider]);

        expect(capturedConfig).not.toBeNull();
        const enabledState = capturedConfig.mcpServers["test-server"]._meta.enabled;
        expect(enabledState.claude).toBe(true);
        expect(enabledState.gemini).toBe(true); // Should preserve existing
    });

    it("should return early if no providers selected", async () => {
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(createMockUnifiedConfig());
        spyOn(logger, "info");

        setMockResponses({
            selectedProviders: [],
        });

        await syncFromProviders([mockProvider]);

        expect(logger.info).toHaveBeenCalledWith("No providers selected. Cancelled.");
    });

    it("should handle errors when reading from providers", async () => {
        mockProvider.errors.set("listServers", new Error("Read failed"));

        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(createMockUnifiedConfig());
        spyOn(logger, "error");
        spyOn(logger, "info");

        setMockResponses({
            selectedProviders: ["claude"],
        });

        await syncFromProviders([mockProvider]);

        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Failed to read from claude"));
    });

    it("should skip providers without config files", async () => {
        mockProvider.configExistsResult = false;

        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(createMockUnifiedConfig());
        spyOn(logger, "warn");

        await syncFromProviders([mockProvider]);

        expect(logger.warn).toHaveBeenCalledWith("No provider configuration files found.");
    });
});
