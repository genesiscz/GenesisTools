import { describe, expect, it, spyOn } from "bun:test";
import { MockMCPProvider } from "@app/mcp-manager/commands/__tests__/test-utils";
import * as installCommand from "@app/mcp-manager/commands/install";
import {
    buildInstallArgs,
    genesisToolsMcpRegistration,
    installGenesisToolsMcp,
    type McpRegistrationReader,
} from "./mcp-install";

function fakeReader(overrides: Partial<McpRegistrationReader> = {}): McpRegistrationReader {
    return {
        configExists: overrides.configExists ?? (async () => true),
        readConfig: overrides.readConfig ?? (async () => ({ mcpServers: {} })),
    };
}

describe("genesisToolsMcpRegistration", () => {
    it("is no-config when ~/.claude.json does not exist yet", async () => {
        const reader = fakeReader({ configExists: async () => false });

        expect(await genesisToolsMcpRegistration(reader)).toBe("no-config");
    });

    it("is false when the config exists but has no genesis-tools entry", async () => {
        const reader = fakeReader({
            readConfig: async () => ({ mcpServers: { "claude-docs": { type: "http", url: "https://example.com" } } }),
        });

        expect(await genesisToolsMcpRegistration(reader)).toBe("not-registered");
    });

    it("is registered once genesis-tools is registered", async () => {
        const reader = fakeReader({
            readConfig: async () => ({
                mcpServers: { "genesis-tools": { type: "stdio", command: "tools", args: ["genesis-tools-mcp"] } },
            }),
        });

        expect(await genesisToolsMcpRegistration(reader)).toBe("registered");
    });

    it("never calls readConfig when the config file is absent (read-only, no needless parse)", async () => {
        let readConfigCalls = 0;
        const reader = fakeReader({
            configExists: async () => false,
            readConfig: async () => {
                readConfigCalls++;
                return { mcpServers: {} };
            },
        });

        await genesisToolsMcpRegistration(reader);

        expect(readConfigCalls).toBe(0);
    });
});

// Regression test: PR #456 review — `tools update` calls this in-process, and installServer is the
// CLI command's body: it ends the PROCESS when the target provider has no config file
describe("installGenesisToolsMcp", () => {
    it("refuses before installServer when the target provider has no config file", async () => {
        const install = spyOn(installCommand, "installServer").mockImplementation(async () => {
            throw new Error("installServer reached");
        });
        const claude = new MockMCPProvider("claude");
        claude.configExistsResult = false;

        try {
            await expect(
                installGenesisToolsMcp({ providers: [claude, new MockMCPProvider("gemini")] })
            ).rejects.toThrow("claude has no config file");
            expect(install).not.toHaveBeenCalled();
        } finally {
            install.mockRestore();
        }
    });

    it("installs through installServer when the provider config exists", async () => {
        const install = spyOn(installCommand, "installServer").mockImplementation(async () => undefined);

        try {
            await installGenesisToolsMcp({ providers: [new MockMCPProvider("claude")] });

            expect(install).toHaveBeenCalledTimes(1);
            expect(install.mock.calls[0]?.[3]).toEqual({ type: "stdio", provider: "claude" });
        } finally {
            install.mockRestore();
        }
    });
});

describe("install --agent", () => {
    it("maps claude, codex and grok to their providers and refuses anything else", () => {
        expect(buildInstallArgs({}).options.provider).toBe("claude");
        expect(buildInstallArgs({ agent: "codex" }).options.provider).toBe("codex");
        expect(buildInstallArgs({ agent: "grok" }).options.provider).toBe("grok");
        expect(() => buildInstallArgs({ agent: "gemini" })).toThrow("--agent must be one of claude, codex, grok");
    });

    it("installs into Grok through installServer when ~/.grok/config.toml exists", async () => {
        const install = spyOn(installCommand, "installServer").mockImplementation(async () => undefined);

        try {
            await installGenesisToolsMcp({ agent: "grok", providers: [new MockMCPProvider("grok")] });

            expect(install).toHaveBeenCalledTimes(1);
            expect(install.mock.calls[0]?.[0]).toBe("genesis-tools");
            expect(install.mock.calls[0]?.[3]).toEqual({ type: "stdio", provider: "grok" });
        } finally {
            install.mockRestore();
        }
    });
});
