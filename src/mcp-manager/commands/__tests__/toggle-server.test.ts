import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { toggleServer } from "../toggle-server.js";
import { MockMCPProvider, createMockUnifiedConfig } from "./test-utils.js";
import * as configUtils from "../../utils/config.utils.js";
import * as commandUtils from "../../utils/command.utils.js";
import logger from "@app/logger";

describe("toggleServer", () => {
    let mockProvider: MockMCPProvider;
    let mockProviders: MockMCPProvider[];

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProviders = [mockProvider];
    });

    describe("enable (enabled = true)", () => {
        it("should enable server when provided via args", async () => {
            const mockConfig = createMockUnifiedConfig();

            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue();
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["test-server"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(["claude"]);
            spyOn(commandUtils, "promptForProjects").mockResolvedValue(null);
            spyOn(logger, "info");
            spyOn(logger, "warn");
            spyOn(logger, "error");

            await toggleServer(true, "test-server", mockProviders);

            expect(mockProvider.enableServersCalls.length).toBe(1);
            expect(mockProvider.enableServersCalls[0].serverNames).toEqual(["test-server"]);
            expect(configUtils.writeUnifiedConfig).toHaveBeenCalled();
        });

        it("should install server if not installed when enabling", async () => {
            const mockConfig = createMockUnifiedConfig();
            mockProvider.getServerConfigResult = null; // Server not installed

            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue();
            spyOn(configUtils, "stripMeta").mockImplementation((config) => {
                const { _meta, ...rest } = config;
                return rest;
            });
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["test-server"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(["claude"]);
            spyOn(commandUtils, "promptForProjects").mockResolvedValue(null);
            spyOn(logger, "info");
            spyOn(logger, "warn");
            spyOn(logger, "error");

            await toggleServer(true, "test-server", mockProviders);

            expect(mockProvider.installServerCalls.length).toBe(1);
            expect(mockProvider.installServerCalls[0].serverName).toBe("test-server");
        });

        it("should handle per-project enablement for Claude", async () => {
            const mockConfig = createMockUnifiedConfig();
            mockProvider.getProjectsResult = ["/path/to/project1", "/path/to/project2"];

            let capturedConfig: any = null;
            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(configUtils, "writeUnifiedConfig").mockImplementation(async (config: any) => {
                capturedConfig = config;
            });
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["test-server"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(["claude"]);
            spyOn(commandUtils, "promptForProjects").mockResolvedValue([
                { projectPath: "/path/to/project1", displayName: "project1" },
            ]);
            spyOn(logger, "info");
            spyOn(logger, "warn");
            spyOn(logger, "error");

            await toggleServer(true, "test-server", mockProviders);

            expect(mockProvider.enableServersCalls.length).toBe(1);
            expect(mockProvider.enableServersCalls[0].projectPath).toBe("/path/to/project1");

            // Verify _meta.enabled was updated with per-project state
            expect(capturedConfig).not.toBeNull();
            const enabledState = capturedConfig.mcpServers["test-server"]._meta.enabled.claude;
            expect(typeof enabledState).toBe("object");
            expect(enabledState["/path/to/project1"]).toBe(true);
        });

        it("should handle global enablement when 'Global' project is selected", async () => {
            const mockConfig = createMockUnifiedConfig();
            mockProvider.getProjectsResult = ["/path/to/project1"];

            let capturedConfig: any = null;
            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(configUtils, "writeUnifiedConfig").mockImplementation(async (config: any) => {
                capturedConfig = config;
            });
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["test-server"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(["claude"]);
            spyOn(commandUtils, "promptForProjects").mockResolvedValue([
                { projectPath: null, displayName: "Global (all projects)" },
            ]);
            spyOn(logger, "info");
            spyOn(logger, "warn");
            spyOn(logger, "error");

            await toggleServer(true, "test-server", mockProviders);

            expect(mockProvider.enableServersCalls.length).toBe(1);
            expect(mockProvider.enableServersCalls[0].projectPath).toBe(null);

            // Verify _meta.enabled was set to boolean true for global
            expect(capturedConfig).not.toBeNull();
            const enabledState = capturedConfig.mcpServers["test-server"]._meta.enabled.claude;
            expect(enabledState).toBe(true);
        });

        it("should return early if no servers found in config", async () => {
            const emptyConfig = { mcpServers: {} };

            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(emptyConfig);
            spyOn(logger, "warn");

            await toggleServer(true, undefined, mockProviders);

            expect(logger.warn).toHaveBeenCalledWith(
                "No servers found in unified config. Run 'tools mcp-manager config' to add servers."
            );
            expect(mockProvider.enableServersCalls.length).toBe(0);
        });

        it("should return early if no servers selected", async () => {
            const mockConfig = createMockUnifiedConfig();

            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(commandUtils, "getServerNames").mockResolvedValue(null);
            spyOn(logger, "info");

            await toggleServer(true, undefined, mockProviders);

            expect(logger.info).toHaveBeenCalledWith("No servers selected.");
            expect(mockProvider.enableServersCalls.length).toBe(0);
        });

        it("should return early if no providers selected", async () => {
            const mockConfig = createMockUnifiedConfig();

            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["test-server"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(null);
            spyOn(logger, "info");

            await toggleServer(true, "test-server", mockProviders);

            expect(logger.info).toHaveBeenCalledWith("No providers selected.");
            expect(mockProvider.enableServersCalls.length).toBe(0);
        });

        it("should handle errors during enable operation", async () => {
            const mockConfig = createMockUnifiedConfig();
            mockProvider.errors.set("enableServers", new Error("Enable failed"));

            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue();
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["test-server"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(["claude"]);
            spyOn(commandUtils, "promptForProjects").mockResolvedValue(null);
            spyOn(logger, "info");
            spyOn(logger, "error");

            await toggleServer(true, "test-server", mockProviders);

            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Failed to enable servers"));
        });
    });

    describe("disable (enabled = false)", () => {
        it("should disable server when provided via args", async () => {
            const mockConfig = createMockUnifiedConfig();

            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue();
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["test-server"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(["claude"]);
            spyOn(commandUtils, "promptForProjects").mockResolvedValue(null);
            spyOn(logger, "info");
            spyOn(logger, "warn");
            spyOn(logger, "error");

            await toggleServer(false, "test-server", mockProviders);

            expect(mockProvider.disableServersCalls.length).toBe(1);
            expect(mockProvider.disableServersCalls[0].serverNames).toEqual(["test-server"]);
            expect(configUtils.writeUnifiedConfig).toHaveBeenCalled();
        });

        it("should not install server when disabling", async () => {
            const mockConfig = createMockUnifiedConfig();

            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue();
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["test-server"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(["claude"]);
            spyOn(commandUtils, "promptForProjects").mockResolvedValue(null);
            spyOn(logger, "info");
            spyOn(logger, "warn");
            spyOn(logger, "error");

            await toggleServer(false, "test-server", mockProviders);

            expect(mockProvider.installServerCalls.length).toBe(0);
            expect(mockProvider.disableServersCalls.length).toBe(1);
        });

        it("should handle per-project disablement", async () => {
            const mockConfig = createMockUnifiedConfig();
            mockProvider.getProjectsResult = ["/path/to/project1"];

            let capturedConfig: any = null;
            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(configUtils, "writeUnifiedConfig").mockImplementation(async (config: any) => {
                capturedConfig = config;
            });
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["test-server"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(["claude"]);
            spyOn(commandUtils, "promptForProjects").mockResolvedValue([
                { projectPath: "/path/to/project1", displayName: "project1" },
            ]);
            spyOn(logger, "info");
            spyOn(logger, "warn");
            spyOn(logger, "error");

            await toggleServer(false, "test-server", mockProviders);

            expect(mockProvider.disableServersCalls.length).toBe(1);
            expect(mockProvider.disableServersCalls[0].projectPath).toBe("/path/to/project1");

            // Verify _meta.enabled was updated with per-project state
            expect(capturedConfig).not.toBeNull();
            const enabledState = capturedConfig.mcpServers["test-server"]._meta.enabled.claude;
            expect(typeof enabledState).toBe("object");
            expect(enabledState["/path/to/project1"]).toBe(false);
        });

        it("should warn if server not found when disabling", async () => {
            const mockConfig = createMockUnifiedConfig();

            spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
            spyOn(commandUtils, "getServerNames").mockResolvedValue(["non-existent"]);
            spyOn(commandUtils, "promptForProviders").mockResolvedValue(["claude"]);
            spyOn(logger, "warn");

            await toggleServer(false, "non-existent", mockProviders);

            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not found in unified config"));
        });
    });
});
