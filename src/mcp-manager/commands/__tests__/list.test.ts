import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { listServers } from "@app/mcp-manager/commands/list.js";
import { MockMCPProvider } from "./test-utils.js";
import type { MCPServerInfo } from "@app/mcp-manager/utils/providers/types.js";
import logger from "@app/logger";

describe("listServers", () => {
    let mockProvider: MockMCPProvider;
    let mockProvider2: MockMCPProvider;

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProvider2 = new MockMCPProvider("gemini", "/mock/gemini.json");
    });

    it("should list servers from all providers", async () => {
        const mockServers: MCPServerInfo[] = [
            {
                name: "test-server",
                config: { command: "test-command" },
                enabled: true,
                provider: "claude",
            },
        ];
        mockProvider.listServersResult = mockServers;
        
        spyOn(logger, "info");

        await listServers([mockProvider]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("MCP Servers"));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("test-server"));
    });

    it("should group servers by name", async () => {
        const mockServers1: MCPServerInfo[] = [
            {
                name: "test-server",
                config: { command: "test-command" },
                enabled: true,
                provider: "claude",
            },
        ];
        const mockServers2: MCPServerInfo[] = [
            {
                name: "test-server",
                config: { command: "test-command" },
                enabled: false,
                provider: "gemini",
            },
        ];
        mockProvider.listServersResult = mockServers1;
        mockProvider2.listServersResult = mockServers2;
        
        spyOn(logger, "info");

        await listServers([mockProvider, mockProvider2]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("partial"));
    });

    it("should show enabled status correctly", async () => {
        const mockServers: MCPServerInfo[] = [
            {
                name: "enabled-server",
                config: { command: "test-command" },
                enabled: true,
                provider: "claude",
            },
            {
                name: "disabled-server",
                config: { command: "test-command" },
                enabled: false,
                provider: "claude",
            },
        ];
        mockProvider.listServersResult = mockServers;
        
        spyOn(logger, "info");

        await listServers([mockProvider]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("enabled-server"));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("disabled-server"));
    });

    it("should return early if no servers found", async () => {
        mockProvider.listServersResult = [];
        
        spyOn(logger, "info");

        await listServers([mockProvider]);

        expect(logger.info).toHaveBeenCalledWith("No MCP servers found.");
    });

    it("should skip providers without config files", async () => {
        mockProvider.configExistsResult = false;
        
        spyOn(logger, "info");

        await listServers([mockProvider]);

        expect(logger.info).toHaveBeenCalledWith("No MCP servers found.");
    });

    it("should handle errors when reading provider configs", async () => {
        mockProvider.errors.set("listServers", new Error("Read failed"));
        
        spyOn(logger, "warn");
        spyOn(logger, "info");

        await listServers([mockProvider]);

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to read claude config")
        );
    });

    it("should display status correctly for all enabled", async () => {
        const mockServers: MCPServerInfo[] = [
            {
                name: "test-server",
                config: { command: "test-command" },
                enabled: true,
                provider: "claude",
            },
            {
                name: "test-server",
                config: { command: "test-command" },
                enabled: true,
                provider: "gemini",
            },
        ];
        mockProvider.listServersResult = [mockServers[0]];
        mockProvider2.listServersResult = [mockServers[1]];
        
        spyOn(logger, "info");

        await listServers([mockProvider, mockProvider2]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("enabled"));
    });
});




