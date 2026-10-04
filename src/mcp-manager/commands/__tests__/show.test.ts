import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { showServerConfig } from "@app/mcp-manager/commands/show.js";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { Storage } from "@genesiscz/utils/storage/storage";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { createMockServerConfig, MockMCPProvider } from "./test-utils.js";

setupStorageSandbox();

describe("showServerConfig", () => {
    let mockProvider: MockMCPProvider;
    let mockProvider2: MockMCPProvider;

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProvider2 = new MockMCPProvider("gemini", "/mock/gemini.json");
    });

    it("should show server config from all providers (via out.println → stdout result)", async () => {
        const mockConfig = createMockServerConfig("test-server");
        mockProvider.getServerConfigResult = mockConfig;
        mockProvider2.getServerConfigResult = mockConfig;

        spyOn(out, "println");

        await showServerConfig("test-server", [mockProvider, mockProvider2]);

        expect(out.println).toHaveBeenCalledWith(expect.stringContaining("Configuration for 'test-server'"));
        expect(out.println).toHaveBeenCalledWith(expect.stringContaining("claude"));
        expect(out.println).toHaveBeenCalledWith(expect.stringContaining("gemini"));
    });

    // Regression test: #447 section E — `tools mcp-manager show` with no server
    // name looked up a server literally named "" and exited 0.
    it("prints usage and exits non-zero when no server name is given outside a TTY", async () => {
        spyOn(logger, "error");
        const originalExitCode = process.exitCode;
        // The runner's own stdin may be a terminal (`script -q`, an interactive shell): pin "not a terminal".
        const stdinWasTty = process.stdin.isTTY;
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true, writable: true });

        try {
            await showServerConfig(undefined, [mockProvider]);

            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Server name required"));
            expect(process.exitCode).toBe(1);
        } finally {
            Object.defineProperty(process.stdin, "isTTY", { value: stdinWasTty, configurable: true, writable: true });
            process.exitCode = originalExitCode;
        }
    });

    // Regression test: Fable judge J3 — `show` only reads; offering the picker must not create the config folder.
    // PR #456 review: the unified config is seeded so the run really reaches the picker, not the empty-list exit.
    it("never creates the mcp-manager folder while preparing the picker", async () => {
        await new Storage("mcp-manager").setConfig({ mcpServers: { "picked-server": { command: "picked-command" } } });
        mockProvider.getServerConfigResult = createMockServerConfig("picked-server");
        const ensureDirs = spyOn(Storage.prototype, "ensureDirs").mockImplementation(async () => {
            throw new Error("show created the mcp-manager folder");
        });
        // Picks whatever the picker itself offers first, so the mock never invents a value.
        const search = spyOn(p, "search").mockImplementation(async (opts) => {
            const [first] = await opts.options("picked");

            if (!first) {
                throw new Error("the picker offered nothing");
            }

            return first.value;
        });
        const println = spyOn(out, "println").mockImplementation(() => undefined);
        const stdinWasTty = process.stdin.isTTY;
        const originalExitCode = process.exitCode;
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true, writable: true });

        try {
            await showServerConfig(undefined, [mockProvider]);

            expect(search).toHaveBeenCalledTimes(1);
            expect(println).toHaveBeenCalledWith(expect.stringContaining("Configuration for 'picked-server'"));
            expect(ensureDirs).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process.stdin, "isTTY", { value: stdinWasTty, configurable: true, writable: true });
            ensureDirs.mockRestore();
            search.mockRestore();
            println.mockRestore();
            process.exitCode = originalExitCode;
        }
    });

    it("should warn (logger → stderr) if server not found in any provider", async () => {
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

        spyOn(out, "println");

        await showServerConfig("test-server", [mockProvider, mockProvider2]);

        expect(out.println).toHaveBeenCalledWith(expect.stringContaining("gemini"));
    });

    it("should display config as JSON", async () => {
        const mockConfig = createMockServerConfig("test-server");
        mockProvider.getServerConfigResult = mockConfig;

        spyOn(out, "println");

        await showServerConfig("test-server", [mockProvider]);

        const jsonCall = (out.println as unknown as { mock: { calls: string[][] } }).mock.calls.find((call: string[]) =>
            call[0].includes("test-server-command")
        );
        expect(jsonCall).toBeDefined();
    });
});
