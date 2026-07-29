import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ListJsonOutput, ListOptions } from "@app/mcp-manager/commands/list.js";
import { listServers } from "@app/mcp-manager/commands/list.js";
import type { MCPServerInfo } from "@app/mcp-manager/utils/providers/types.js";
import { logger, out } from "@genesiscz/utils/logger";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { MockMCPProvider } from "./test-utils.js";

setupStorageSandbox();

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

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to read claude config"));
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

describe("listServers --json", () => {
    let mockProvider: MockMCPProvider;
    let mockProvider2: MockMCPProvider;

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProvider2 = new MockMCPProvider("gemini", "/mock/gemini.json");
    });

    /** Run the JSON path and hand back the payload `out.result` was called with. */
    async function jsonOutput(providers: MockMCPProvider[], options: ListOptions = {}): Promise<ListJsonOutput> {
        const spy = spyOn(out, "result");
        await listServers(providers, { ...options, json: true });
        // Last call, not first: the spy may be shared across tests in this file.
        return spy.mock.calls.at(-1)?.[0] as ListJsonOutput;
    }

    it("emits transport details and drops _meta bookkeeping", async () => {
        mockProvider.listServersResult = [
            {
                name: "stdio-server",
                config: {
                    command: "bun",
                    args: ["run", "server.ts"],
                    env: { TOKEN: "x" },
                    _meta: { enabled: { claude: true } },
                },
                enabled: true,
                provider: "claude",
            },
            {
                name: "http-server",
                config: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
                enabled: true,
                provider: "claude",
            },
        ];

        const payload = await jsonOutput([mockProvider]);

        expect(payload.servers.map((s) => s.name)).toEqual(["http-server", "stdio-server"]);
        expect(payload.servers[0].connection).toEqual({
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer x" },
        });
        expect(payload.servers[1].connection).toEqual({
            type: "stdio",
            command: "bun",
            args: ["run", "server.ts"],
            env: { TOKEN: "x" },
        });
        expect(payload.providersScanned).toEqual(["claude"]);
        expect(payload.providersFailed).toEqual([]);
    });

    it("reports the enabled provider's config when instances disagree", async () => {
        mockProvider.listServersResult = [
            { name: "dual", config: { command: "stale" }, enabled: false, provider: "claude" },
        ];
        mockProvider2.listServersResult = [
            { name: "dual", config: { command: "live" }, enabled: true, provider: "gemini" },
        ];

        const payload = await jsonOutput([mockProvider, mockProvider2]);

        expect(payload.servers[0].status).toBe("partial");
        expect(payload.servers[0].enabled).toBe(true);
        expect(payload.servers[0].connection.command).toBe("live");
        expect(payload.servers[0].providers).toEqual([
            { provider: "claude", enabled: false },
            { provider: "gemini", enabled: true },
        ]);
    });

    it("drops fully-disabled servers under enabledOnly", async () => {
        mockProvider.listServersResult = [
            { name: "on", config: { command: "a" }, enabled: true, provider: "claude" },
            { name: "off", config: { command: "b" }, enabled: false, provider: "claude" },
        ];

        const payload = await jsonOutput([mockProvider], { enabledOnly: true });

        expect(payload.servers.map((s) => s.name)).toEqual(["on"]);
    });

    it("emits an empty payload instead of the human 'no servers' notice", async () => {
        mockProvider.listServersResult = [];

        const spy = spyOn(out, "result");
        const callsBefore = spy.mock.calls.length;
        await listServers([mockProvider], { json: true });

        // One NEW result call proves the empty case did not fall through to the
        // human early-return, which would leave stdout unparseable for consumers.
        expect(spy.mock.calls.length).toBe(callsBefore + 1);

        const payload = spy.mock.calls.at(-1)?.[0] as ListJsonOutput;
        expect(payload.servers).toEqual([]);
        expect(payload.providersScanned).toEqual(["claude"]);
        expect(payload.providersFailed).toEqual([]);
    });

    it("separates scanned providers from ones that threw", async () => {
        mockProvider.errors.set("listServers", new Error("Read failed"));
        mockProvider2.listServersResult = [{ name: "ok", config: { command: "a" }, enabled: true, provider: "gemini" }];

        const payload = await jsonOutput([mockProvider, mockProvider2]);

        expect(payload.providersScanned).toEqual(["gemini"]);
        expect(payload.providersFailed).toEqual([{ provider: "claude", error: "Read failed" }]);
    });
});
