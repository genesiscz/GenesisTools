import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";
import { setupInquirerMock } from "./inquirer-mock.js";

// Setup prompt mock + storage sandbox BEFORE importing modules under test
setupInquirerMock();
setupStorageSandbox();

const { ClaudeProvider } = await import("@app/mcp-manager/utils/providers/claude.js");
const { syncServers } = await import("../sync.js");
const { syncFromProviders } = await import("../sync-from-providers.js");
const { renameServer } = await import("../rename.js");
const { disableServer: disableCommand } = await import("../disable.js");
const { enableServer: enableCommand } = await import("../enable.js");

import { logger } from "@app/logger";
import * as configUtils from "@app/mcp-manager/utils/config.utils.js";
import { setGlobalOptions } from "@app/mcp-manager/utils/config.utils.js";
import type { ClaudeGenericConfig } from "@app/mcp-manager/utils/providers/claude.types.js";
import type { UnifiedMCPConfig, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage";

/**
 * Fixture tests for the TRUE global-disable scheme of the Claude provider.
 *
 * All writes go to a temp HOME (~/.claude.json fixture) and the sandboxed
 * Storage (unified config) — the real ~/.claude.json is never touched.
 */

const SERENA: UnifiedMCPServerConfig = { type: "stdio", command: "uvx", args: ["serena"] };
const GITHUB: UnifiedMCPServerConfig = { type: "stdio", command: "bunx", args: ["github-mcp"] };

function claudeFixture(): Record<string, unknown> {
    return {
        numStartups: 5, // unrelated precious state — must survive writes
        mcpServers: { serena: { ...SERENA }, github: { ...GITHUB } },
        disabledMcpServers: [],
        projects: {
            "/proj/a": { mcpServers: {}, disabledMcpServers: [], history: ["precious"] },
            "/proj/b": { mcpServers: {}, disabledMcpServers: [] },
        },
    };
}

function unifiedFixture(): UnifiedMCPConfig {
    return {
        mcpServers: {
            serena: { ...SERENA, _meta: { enabled: { claude: true } } },
            github: { ...GITHUB, _meta: { enabled: { claude: true } } },
        },
    };
}

describe("claude provider TRUE global disable", () => {
    let homeDir: string;
    let prevHome: string | undefined;

    const claudeJsonPath = () => join(homeDir, ".claude.json");

    const writeClaudeJson = (config: Record<string, unknown>) => {
        writeFileSync(claudeJsonPath(), SafeJSON.stringify(config, null, 2));
    };

    const readClaudeJson = (): ClaudeGenericConfig & Record<string, unknown> => {
        return SafeJSON.parse(readFileSync(claudeJsonPath(), "utf-8")) as ClaudeGenericConfig & Record<string, unknown>;
    };

    const writeUnified = async (config: UnifiedMCPConfig) => {
        const storage = new Storage("mcp-manager");
        await storage.ensureDirs();
        await storage.setConfig(config);
    };

    const readUnified = async (): Promise<UnifiedMCPConfig> => {
        const storage = new Storage("mcp-manager");
        return (await storage.getConfig<UnifiedMCPConfig>()) ?? { mcpServers: {} };
    };

    beforeEach(() => {
        // Other mcp-manager test files spy on configUtils (readUnifiedConfig/
        // writeUnifiedConfig) without restoring; bun runs all files in one
        // process, so restore everything BEFORE installing our own spies.
        mock.restore();
        prevHome = env.get("HOME");
        homeDir = mkdtempSync(join(tmpdir(), "mcp-claude-global-"));
        env.testing.set("HOME", homeDir);
        setGlobalOptions({ yes: true });
        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});
        spyOn(logger, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
        mock.restore();
        if (prevHome) {
            env.testing.set("HOME", prevHome);
        } else {
            env.testing.unset("HOME");
        }
        setGlobalOptions({});
        rmSync(homeDir, { recursive: true, force: true });
    });

    describe("disableServer(name, null) — global", () => {
        it("removes the entry from mcpServers, keeps markers, preserves unknown keys", async () => {
            writeClaudeJson(claudeFixture());
            await writeUnified(unifiedFixture());

            const provider = new ClaudeProvider();
            await provider.disableServer("serena", null);

            const claude = readClaudeJson();
            expect(claude.mcpServers?.serena).toBeUndefined(); // TRUE global disable
            expect(claude.mcpServers?.github).toBeDefined(); // untouched sibling
            expect(claude.disabledMcpServers).toContain("serena"); // legacy marker
            expect(claude.projects?.["/proj/a"].disabledMcpServers).toContain("serena"); // sweep
            expect(claude.projects?.["/proj/b"].disabledMcpServers).toContain("serena");
            // Unrelated state preserved (read-modify-write)
            expect(claude.numStartups).toBe(5);
            expect((claude.projects?.["/proj/a"] as Record<string, unknown>).history).toEqual(["precious"]);

            // Full config preserved in unified config with claude disabled
            const unified = await readUnified();
            expect(unified.mcpServers.serena.command).toBe("uvx");
            expect(unified.mcpServers.serena._meta?.enabled?.claude).toBe(false);
        });

        it("imports the server into the unified config when it is missing there", async () => {
            writeClaudeJson(claudeFixture());
            await writeUnified({ mcpServers: {} });

            const provider = new ClaudeProvider();
            await provider.disableServer("serena", null);

            const unified = await readUnified();
            expect(unified.mcpServers.serena).toBeDefined();
            expect(unified.mcpServers.serena.command).toBe("uvx");
            expect(unified.mcpServers.serena.args).toEqual(["serena"]);
            expect(unified.mcpServers.serena._meta?.enabled?.claude).toBe(false);

            expect(readClaudeJson().mcpServers?.serena).toBeUndefined();
        });

        it("does NOT remove the entry when it cannot be preserved in the unified config", async () => {
            writeClaudeJson(claudeFixture());
            await writeUnified({ mcpServers: {} });

            // Simulate rejected/failed unified-config write during import
            spyOn(configUtils, "writeUnifiedConfig").mockResolvedValue(false);

            const provider = new ClaudeProvider();
            await provider.disableServer("serena", null);

            const claude = readClaudeJson();
            expect(claude.mcpServers?.serena).toBeDefined(); // kept — no data loss
            expect(claude.disabledMcpServers).toContain("serena"); // markers still applied
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("NOT removed"));
        });
    });

    describe("disableServer(name, '/project') — per-project unchanged", () => {
        it("keeps the entry in mcpServers and only updates the project's disabled list", async () => {
            writeClaudeJson(claudeFixture());
            await writeUnified(unifiedFixture());

            const provider = new ClaudeProvider();
            await provider.disableServer("serena", "/proj/a");

            const claude = readClaudeJson();
            expect(claude.mcpServers?.serena).toBeDefined(); // still installed
            expect(claude.disabledMcpServers).toEqual([]); // top-level untouched
            expect(claude.projects?.["/proj/a"].disabledMcpServers).toContain("serena");
            expect(claude.projects?.["/proj/b"].disabledMcpServers).toEqual([]);

            const unified = await readUnified();
            expect(unified.mcpServers.serena._meta?.enabled?.claude).toBe(true); // untouched
        });
    });

    describe("enableServer(name, null) — global", () => {
        it("restores the entry from the unified config and cleans all disabled lists", async () => {
            const claude = claudeFixture();
            delete (claude.mcpServers as Record<string, unknown>).serena; // globally disabled = absent
            claude.disabledMcpServers = ["serena"];
            (claude.projects as Record<string, { disabledMcpServers: string[] }>)["/proj/a"].disabledMcpServers = [
                "serena",
            ];
            writeClaudeJson(claude);

            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = { enabled: { claude: false } };
            await writeUnified(unified);

            const provider = new ClaudeProvider();
            await provider.enableServer("serena", null);

            const result = readClaudeJson();
            expect(result.mcpServers?.serena).toBeDefined(); // restored
            expect(result.mcpServers?.serena.command).toBe("uvx");
            expect((result.mcpServers?.serena as Record<string, unknown>)._meta).toBeUndefined(); // no _meta leak
            expect(result.disabledMcpServers).not.toContain("serena");
            expect(result.projects?.["/proj/a"].disabledMcpServers).not.toContain("serena");
        });
    });

    describe("listServers", () => {
        it("reports a globally-disabled (absent) server as disabled, not missing", async () => {
            const claude = claudeFixture();
            delete (claude.mcpServers as Record<string, unknown>).serena;
            writeClaudeJson(claude);

            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = { enabled: { claude: false } };
            await writeUnified(unified);

            const provider = new ClaudeProvider();
            const servers = await provider.listServers();

            const serena = servers.find((s) => s.name === "serena");
            expect(serena).toBeDefined();
            expect(serena?.enabled).toBe(false);
            expect(serena?.provider).toBe("claude");
            expect(serena?.config._meta).toBeUndefined(); // _meta stays in unified config
        });
    });

    describe("syncServers (provider)", () => {
        it("removes globally-disabled servers from mcpServers and keeps enabled ones", async () => {
            writeClaudeJson(claudeFixture()); // serena still installed (drift)
            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = { enabled: { claude: false } };
            await writeUnified(unified);

            const provider = new ClaudeProvider();
            await provider.syncServers(unified.mcpServers);

            const claude = readClaudeJson();
            expect(claude.mcpServers?.serena).toBeUndefined(); // drift corrected
            expect(claude.mcpServers?.github).toBeDefined();
            expect(claude.disabledMcpServers).toContain("serena");
            expect(claude.disabledMcpServers).not.toContain("github");
        });
    });

    describe("sync command", () => {
        it("does not (re)install globally-disabled servers", async () => {
            writeClaudeJson({
                numStartups: 5,
                mcpServers: {},
                disabledMcpServers: [],
                projects: {},
            });
            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = { enabled: { claude: false } };
            await writeUnified(unified);

            const provider = new ClaudeProvider();
            await syncServers([provider], { provider: "claude" });

            const claude = readClaudeJson();
            expect(claude.mcpServers?.github).toBeDefined(); // enabled → installed
            expect(claude.mcpServers?.serena).toBeUndefined(); // disabled → stays absent
        });
    });

    describe("sync-from-providers command", () => {
        it("does not drop or re-enable a globally-disabled server that is absent from ~/.claude.json", async () => {
            const claude = claudeFixture();
            delete (claude.mcpServers as Record<string, unknown>).serena; // absent = globally disabled
            writeClaudeJson(claude);

            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = { enabled: { claude: false } };
            await writeUnified(unified);

            const provider = new ClaudeProvider();
            await syncFromProviders([provider], { provider: "claude" });

            const result = await readUnified();
            expect(result.mcpServers.serena).toBeDefined(); // not interpreted as "user deleted it"
            expect(result.mcpServers.serena.command).toBe("uvx");
            expect(result.mcpServers.serena._meta?.enabled?.claude).toBe(false); // flag not flipped
        });
    });

    describe("rename command", () => {
        it("renames a globally-disabled server in the unified config without installing it in claude", async () => {
            writeClaudeJson({
                mcpServers: {},
                disabledMcpServers: ["serena"],
                projects: { "/proj/a": { mcpServers: {}, disabledMcpServers: ["serena"] } },
            });

            await writeUnified({
                mcpServers: { serena: { ...SERENA, _meta: { enabled: { claude: false } } } },
            });

            const provider = new ClaudeProvider();
            await renameServer("serena", "serena-x", [provider]);

            const unified = await readUnified();
            expect(unified.mcpServers["serena-x"]).toBeDefined();
            expect(unified.mcpServers["serena-x"]._meta?.enabled?.claude).toBe(false);
            expect(unified.mcpServers.serena).toBeUndefined();

            const claude = readClaudeJson();
            expect(claude.mcpServers?.["serena-x"]).toBeUndefined(); // still globally disabled = absent
            expect(claude.mcpServers?.serena).toBeUndefined();
        });
    });

    describe("disable/enable commands end-to-end (toggle flow)", () => {
        it("disable --provider claude removes the entry and flips _meta to false", async () => {
            writeClaudeJson(claudeFixture());
            await writeUnified(unifiedFixture());

            const provider = new ClaudeProvider();
            await disableCommand("serena", [provider], { provider: "claude" });

            expect(readClaudeJson().mcpServers?.serena).toBeUndefined();
            const unified = await readUnified();
            expect(unified.mcpServers.serena._meta?.enabled?.claude).toBe(false);
            expect(unified.mcpServers.serena.command).toBe("uvx");
        });

        it("enable --provider claude reinstalls the entry and flips _meta to true", async () => {
            const claude = claudeFixture();
            delete (claude.mcpServers as Record<string, unknown>).serena;
            claude.disabledMcpServers = ["serena"];
            writeClaudeJson(claude);

            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = { enabled: { claude: false } };
            await writeUnified(unified);

            const provider = new ClaudeProvider();
            await enableCommand("serena", [provider], { provider: "claude" });

            const result = readClaudeJson();
            expect(result.mcpServers?.serena).toBeDefined();
            expect(result.disabledMcpServers).not.toContain("serena");

            const unifiedAfter = await readUnified();
            expect(unifiedAfter.mcpServers.serena._meta?.enabled?.claude).toBe(true);
        });
    });
});
