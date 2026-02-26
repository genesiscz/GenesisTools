import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setMockResponses, setupInquirerMock } from "./inquirer-mock.js";

// Setup @inquirer/prompts mock BEFORE importing command modules
setupInquirerMock();

// Now import after mocking
const { renameServer } = await import("../rename.js");

import logger from "@app/logger";
import * as configUtils from "@app/mcp-manager/utils/config.utils.js";
import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import { createMockUnifiedConfig, MockMCPProvider } from "./test-utils.js";

describe("renameServer", () => {
    let mockProvider: MockMCPProvider;
    let mockProviders: MockMCPProvider[];

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProviders = [mockProvider];

        // Reset mock responses
        setMockResponses({
            selectedOldName: "test-server",
            inputNewName: "renamed-server",
            selectedProviders: ["claude"],
            confirmed: true,
        });
    });

    it("should rename server in unified config and providers", async () => {
        const mockConfig = createMockUnifiedConfig();

        const writeUnifiedConfigSpy = spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "info");
        spyOn(logger, "warn");
        spyOn(logger, "error");

        setMockResponses({
            selectedOldName: "test-server",
            inputNewName: "renamed-server",
            selectedProviders: ["claude"],
        });

        await renameServer(undefined, undefined, mockProviders);

        expect(configUtils.writeUnifiedConfig).toHaveBeenCalled();
        // Get the last call to writeUnifiedConfig
        const calls = writeUnifiedConfigSpy.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const lastCall = calls[calls.length - 1][0] as UnifiedMCPConfig;
        expect(lastCall.mcpServers["renamed-server"]).toBeDefined();
        expect(lastCall.mcpServers["test-server"]).toBeUndefined();
    });

    it("should handle conflict when new name already exists", async () => {
        const mockConfig = createMockUnifiedConfig();
        mockConfig.mcpServers["existing-server"] = createMockUnifiedConfig().mcpServers["test-server"];

        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(logger, "info");
        spyOn(logger, "warn");

        setMockResponses({
            selectedOldName: "test-server",
            inputNewName: "existing-server",
            selectedProviders: ["claude"],
            confirmed: true,
        });

        await renameServer("test-server", "existing-server", mockProviders);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Conflict detected"));
    });

    it("should return early if old name not found", async () => {
        const mockConfig = createMockUnifiedConfig();

        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "error");

        await renameServer("non-existent", "new-name", mockProviders);

        expect(logger.error).toHaveBeenCalledWith("Server 'non-existent' not found in unified config.");
    });

    it("should return early if old and new names are the same", async () => {
        const mockConfig = createMockUnifiedConfig();

        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "warn");

        await renameServer("test-server", "test-server", mockProviders);

        expect(logger.warn).toHaveBeenCalledWith("Old name and new name are the same. No changes needed.");
    });

    it("should handle provider conflicts", async () => {
        const mockConfig = createMockUnifiedConfig();
        // Add "existing-server" to unified config first (to trigger in-provider conflict)
        mockConfig.mcpServers["existing-server"] = createMockUnifiedConfig().mcpServers["test-server"];
        const mockServerInfo = {
            name: "existing-server",
            config: { command: "existing-command" },
            enabled: true,
            provider: "claude",
        };
        mockProvider.listServersResult = [mockServerInfo];

        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(logger, "info");
        const warnSpy = spyOn(logger, "warn");

        setMockResponses({
            selectedProviders: ["claude"],
            confirmed: true,
        });

        await renameServer("test-server", "existing-server", mockProviders);

        // Should detect conflict in unified config (since existing-server already exists there)
        const warnCalls = warnSpy.mock.calls.map((call) => call[0]);
        const hasConflictWarning = warnCalls.some(
            (msg) => typeof msg === "string" && (msg.includes("Conflict") || msg.includes("conflict"))
        );
        expect(hasConflictWarning).toBe(true);
    });

    it("should update enabledMcpServers when renaming", async () => {
        const mockConfig = createMockUnifiedConfig();
        mockConfig.enabledMcpServers = {
            "test-server": { claude: true },
        };

        const writeUnifiedConfigSpy = spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "info");

        setMockResponses({
            selectedProviders: ["claude"],
        });

        await renameServer("test-server", "renamed-server", mockProviders);

        // Get the last call to writeUnifiedConfig
        const calls = writeUnifiedConfigSpy.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const lastCall = calls[calls.length - 1][0] as UnifiedMCPConfig;
        expect(lastCall.enabledMcpServers!["renamed-server"]).toBeDefined();
        expect(lastCall.enabledMcpServers!["test-server"]).toBeUndefined();
    });
});
