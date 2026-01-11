import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { setupEnquirerMock, setMockResponses } from "./enquirer-mock.js";

// Setup Enquirer mock BEFORE importing command modules
setupEnquirerMock();

// Now import after mocking
const { syncServers } = await import("../sync.js");
import { MockMCPProvider, createMockUnifiedConfig } from "./test-utils.js";
import * as configUtils from "../../utils/config.utils.js";
import logger from "@app/logger";

describe("syncServers", () => {
    let mockProvider: MockMCPProvider;
    let mockProviders: MockMCPProvider[];

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProviders = [mockProvider];
        
        // Reset mock responses
        setMockResponses({ selectedProviders: ["claude"] });
    });

    it("should sync servers to selected providers", async () => {
        const mockConfig = createMockUnifiedConfig();
        setMockResponses({ selectedProviders: ["claude"] });
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");
        spyOn(logger, "warn");
        spyOn(logger, "error");

        await syncServers(mockProviders);

        expect(mockProvider.syncServersCalls.length).toBe(1);
        expect(Object.keys(mockProvider.syncServersCalls[0].servers)).toContain("test-server");
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Synced to claude"));
    });

    it("should install missing servers before syncing", async () => {
        const mockConfig = createMockUnifiedConfig();
        mockProvider.getServerConfigResult = null;
        setMockResponses({ selectedProviders: ["claude"] });
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");
        spyOn(logger, "warn");
        spyOn(logger, "error");

        await syncServers(mockProviders);

        expect(mockProvider.installServerCalls.length).toBeGreaterThan(0);
        expect(mockProvider.syncServersCalls.length).toBe(1);
    });

    it("should skip providers that don't have config files", async () => {
        const mockConfig = createMockUnifiedConfig();
        mockProvider.configExistsResult = false;
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(logger, "warn");

        await syncServers(mockProviders);

        expect(logger.warn).toHaveBeenCalledWith("No provider configuration files found.");
        expect(mockProvider.syncServersCalls.length).toBe(0);
    });

    it("should return early if no servers in config", async () => {
        const emptyConfig = { mcpServers: {} };
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(emptyConfig);
        spyOn(logger, "warn");

        await syncServers(mockProviders);

        expect(logger.warn).toHaveBeenCalledWith(
            "No servers found in unified config. Run 'tools mcp-manager config' to add servers."
        );
    });

    it("should handle errors during sync", async () => {
        const mockConfig = createMockUnifiedConfig();
        mockProvider.errors.set("syncServers", new Error("Sync failed"));
        setMockResponses({ selectedProviders: ["claude"] });
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");
        spyOn(logger, "error");

        await syncServers(mockProviders);

        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to sync to claude")
        );
    });

    it("should handle multiple providers", async () => {
        const mockConfig = createMockUnifiedConfig();
        const mockProvider2 = new MockMCPProvider("gemini", "/mock/gemini.json");
        const allProviders = [mockProvider, mockProvider2];
        setMockResponses({ selectedProviders: ["claude", "gemini"] });
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");

        await syncServers(allProviders);

        expect(mockProvider.syncServersCalls.length).toBe(1);
        expect(mockProvider2.syncServersCalls.length).toBe(1);
    });
});
