import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { setupInquirerMock, setMockResponses } from "./inquirer-mock.js";

// Setup @inquirer/prompts mock BEFORE importing command modules
setupInquirerMock();

// Now import after mocking
const { installServer } = await import("../install.js");
import { MockMCPProvider, createMockUnifiedConfig } from "./test-utils.js";
import * as configUtils from "../../utils/config.utils.js";
import logger from "@app/logger";

describe("installServer", () => {
    let mockProvider: MockMCPProvider;
    let mockProviders: MockMCPProvider[];

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProviders = [mockProvider];

        // Reset mock responses
        setMockResponses({
            selectedProvider: "claude",
            inputServerName: "test-server",
            inputType: "stdio",
            inputCommand: "test-command",
            inputEnv: "",
        });
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

        setMockResponses({
            selectedProvider: "claude",
            inputType: "stdio",
        });

        await installServer("new-server", "npx -y @modelcontextprotocol/server-github", mockProviders);

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

        setMockResponses({
            inputServerName: "prompted-server",
            inputType: "stdio",
            inputCommand: "test-command",
            inputEnv: "",
            selectedProvider: "claude",
        });

        await installServer(undefined, undefined, mockProviders);

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

        setMockResponses({
            selectedProvider: "claude",
            inputType: "stdio",
        });

        await installServer("test-server", "npx -y @modelcontextprotocol/server-github", mockProviders);

        expect(mockProvider.installServerCalls.length).toBe(1);
    });

    it("should parse ENV variables correctly", async () => {
        const mockConfig = createMockUnifiedConfig();

        const writeUnifiedConfigSpy = spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(true);
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");

        // parseEnvString expects either JSON format or single KEY=value per item
        // Using JSON format for the test
        setMockResponses({
            inputType: "stdio",
            inputEnv: '{"KEY1":"value1","KEY2":"value2"}',
            selectedProvider: "claude",
        });

        await installServer("new-server", "test-command", mockProviders);

        // Get the last call to writeUnifiedConfig
        const calls = writeUnifiedConfigSpy.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const lastCall = calls[calls.length - 1][0] as any;
        const serverConfig = lastCall.mcpServers["new-server"];
        expect(serverConfig).toBeDefined();
        expect(serverConfig.env).toBeDefined();
        expect(serverConfig.env.KEY1).toBe("value1");
        expect(serverConfig.env.KEY2).toBe("value2");
    });

    it("should return early if no providers available", async () => {
        const mockConfig = createMockUnifiedConfig();
        mockProvider.configExistsResult = false;

        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "warn");

        setMockResponses({
            selectedProvider: "claude",
            inputType: "stdio",
        });

        await installServer("new-server", "test-command", mockProviders);

        expect(logger.warn).toHaveBeenCalledWith("No provider configuration files found.");
    });

    it("should handle command parsing errors", async () => {
        const mockConfig = createMockUnifiedConfig();

        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "error");
        spyOn(logger, "warn");

        setMockResponses({
            inputType: "stdio",
            inputCommand: "", // Empty command should cause error
        });

        await installServer("new-server", undefined, mockProviders);

        // Should handle empty command gracefully (returns early with warning)
        expect(logger.warn).toHaveBeenCalled();
    });
});
