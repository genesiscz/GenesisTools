import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import logger, { consoleLog } from "@app/logger";
import { showServerConfig } from "@app/mcp-manager/commands/show.js";
import { createMockServerConfig, MockMCPProvider } from "./test-utils.js";

describe("showServerConfig", () => {
    let mockProvider: MockMCPProvider;
    let mockProvider2: MockMCPProvider;

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProvider2 = new MockMCPProvider("gemini", "/mock/gemini.json");
    });

    it("should show server config from all providers", async () => {
        const mockConfig = createMockServerConfig("test-server");
        mockProvider.getServerConfigResult = mockConfig;
        mockProvider2.getServerConfigResult = mockConfig;

        spyOn(consoleLog, "info");
        spyOn(logger, "warn");

        await showServerConfig("test-server", [mockProvider, mockProvider2]);

        expect(consoleLog.info).toHaveBeenCalledWith(expect.stringContaining("Configuration for 'test-server'"));
        expect(consoleLog.info).toHaveBeenCalledWith(expect.stringContaining("claude"));
        expect(consoleLog.info).toHaveBeenCalledWith(expect.stringContaining("gemini"));
    });

    it("should warn if server not found in any provider", async () => {
        mockProvider.getServerConfigResult = null;
        mockProvider2.getServerConfigResult = null;

        spyOn(logger, "warn");

        await showServerConfig("non-existent", [mockProvider, mockProvider2]);

        expect(logger.warn).toHaveBeenCalledWith("Server 'non-existent' not found in any provider.");
    });

    it("should skip providers without config files", async () => {
        const mockConfig = createMockServerConfig("test-server");
        mockProvider.configExistsResult = false;
        mockProvider2.getServerConfigResult = mockConfig;

        spyOn(consoleLog, "info");

        await showServerConfig("test-server", [mockProvider, mockProvider2]);

        expect(consoleLog.info).toHaveBeenCalledWith(expect.stringContaining("gemini"));
    });

    it("should display config as JSON", async () => {
        const mockConfig = createMockServerConfig("test-server");
        mockProvider.getServerConfigResult = mockConfig;

        spyOn(consoleLog, "info");

        await showServerConfig("test-server", [mockProvider]);

        const jsonCall = (consoleLog.info as unknown as { mock: { calls: string[][] } }).mock.calls.find(
            (call: string[]) => call[0].includes("test-server-command"),
        );
        expect(jsonCall).toBeDefined();
    });
});
