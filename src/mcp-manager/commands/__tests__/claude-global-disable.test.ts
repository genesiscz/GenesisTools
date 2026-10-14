import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteIo } from "@genesiscz/utils/storage/atomic-file";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { setupInquirerMock } from "./inquirer-mock.js";

// Setup prompt mock + storage sandbox BEFORE importing modules under test
setupInquirerMock();
setupStorageSandbox();

const { ClaudeProvider } = await import("@app/mcp-manager/utils/providers/claude.js");
const { CodexProvider } = await import("@app/mcp-manager/utils/providers/codex.js");
const { GrokProvider } = await import("@app/mcp-manager/utils/providers/grok.js");
const { syncServers } = await import("../sync.js");
const { syncFromProviders } = await import("../sync-from-providers.js");
const { renameServer } = await import("../rename.js");
const { disableServer: disableCommand } = await import("../disable.js");
const { enableServer: enableCommand } = await import("../enable.js");

import * as configUtils from "@app/mcp-manager/utils/config.utils.js";
import { setGlobalOptions } from "@app/mcp-manager/utils/config.utils.js";
import type { ClaudeGenericConfig } from "@app/mcp-manager/utils/providers/claude.types.js";
import type { UnifiedMCPConfig, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { WriteResult } from "@app/mcp-manager/utils/providers/types.js";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import * as TOML from "@iarna/toml";

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
        // Intended change 2026-10-13: a global disable no longer sweeps the name into every
        // project's disabledMcpServers list. Global means the global switch only.
        it("removes the entry from mcpServers, keeps the top-level marker, leaves every project alone", async () => {
            writeClaudeJson(claudeFixture());
            await writeUnified(unifiedFixture());

            const provider = new ClaudeProvider();
            await provider.disableServer("serena", null);

            const claude = readClaudeJson();
            expect(claude.mcpServers?.serena).toBeUndefined(); // TRUE global disable
            expect(claude.mcpServers?.github).toBeDefined(); // untouched sibling
            expect(claude.disabledMcpServers).toContain("serena"); // mcp-manager marker
            expect(claude.projects).toEqual(claudeFixture().projects as ClaudeGenericConfig["projects"]); // no sweep
            // Unrelated state preserved (read-modify-write)
            expect(claude.numStartups).toBe(5);
            expect((claude.projects?.["/proj/a"] as Record<string, unknown> | undefined)?.history).toEqual([
                "precious",
            ]);

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
            expect(claude.disabledMcpServers).toContain("serena"); // marker still applied
            expect(claude.projects).toEqual(claudeFixture().projects as ClaudeGenericConfig["projects"]);
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("NOT removed"));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("still loads it in every project"));
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
        /**
         * serena globally disabled (absent) and still on three project lists, one of them a project
         * with a project-scope entry: the list switches it off there too, so it counts.
         */
        const listedEverywhere = async () => {
            const claude = claudeFixture();
            delete (claude.mcpServers as Record<string, unknown>).serena; // globally disabled = absent
            claude.disabledMcpServers = ["serena"];
            const projects = claude.projects as Record<string, Record<string, unknown>>;
            projects["/proj/a"].disabledMcpServers = ["github", "serena"];
            projects["/proj/b"].disabledMcpServers = ["serena"];
            projects["/proj/c"] = { mcpServers: { serena: { ...SERENA } }, disabledMcpServers: ["serena"] };
            projects["/proj/d"] = { mcpServers: {}, disabledMcpServers: ["github"] };
            writeClaudeJson(claude);

            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = { enabled: { claude: false } };
            await writeUnified(unified);
            return projects;
        };

        // Intended change 2026-10-13: a global enable no longer cleans the project lists; it
        // warns with the count instead and names --clear-project-overrides and --project.
        it("restores the entry, drops the top-level marker, leaves project lists and warns with the count", async () => {
            const projects = await listedEverywhere();

            const provider = new ClaudeProvider();
            await provider.enableServer("serena", null);

            const result = readClaudeJson();
            expect(result.mcpServers?.serena).toBeDefined(); // restored
            expect(result.mcpServers?.serena.command).toBe("uvx");
            expect((result.mcpServers?.serena as Record<string, unknown> | undefined)?._meta).toBeUndefined(); // no _meta leak
            expect(result.disabledMcpServers).not.toContain("serena");
            expect(result.projects).toEqual(projects as ClaudeGenericConfig["projects"]); // lists untouched
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("3 project(s)"));
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining("tools mcp-manager enable serena -p claude --clear-project-overrides")
            );
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining("tools mcp-manager enable serena -p claude --project <path>")
            );
        });

        it("enable --clear-project-overrides takes the name off every project list and counts them", async () => {
            const projects = await listedEverywhere();
            const provider = new ClaudeProvider();

            await enableCommand("serena", [provider], { provider: "claude", clearProjectOverrides: true });

            const result = readClaudeJson();
            expect(result.mcpServers?.serena).toBeDefined(); // the global switch is on as well
            expect(result.projects?.["/proj/a"].disabledMcpServers).toEqual(["github"]); // other names stay
            expect(result.projects?.["/proj/b"].disabledMcpServers).toEqual([]);
            expect(result.projects?.["/proj/c"].disabledMcpServers).toEqual([]);
            expect(result.projects?.["/proj/c"].mcpServers?.serena).toBeDefined(); // entry kept
            expect(result.projects?.["/proj/d"]).toEqual(projects["/proj/d"] as never); // never listed it
            expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("list of 3 project(s)"));
            expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("still list it"));
            expect((await readUnified()).mcpServers.serena._meta?.enabled?.claude).toBe(true);
        });

        it("--clear-project-overrides does not widen a per-project enable", async () => {
            await listedEverywhere();
            const provider = new ClaudeProvider();

            await enableCommand("serena", [provider], {
                provider: "claude",
                project: ["/proj/a"],
                clearProjectOverrides: true,
            });

            const result = readClaudeJson();
            expect(result.projects?.["/proj/a"].disabledMcpServers).toEqual(["github"]);
            expect(result.projects?.["/proj/b"].disabledMcpServers).toEqual(["serena"]); // untouched
            expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("applies to a global enable"));
        });

        it("does not warn when no project lists the server", async () => {
            const claude = claudeFixture();
            delete (claude.mcpServers as Record<string, unknown>).serena;
            writeClaudeJson(claude);
            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = { enabled: { claude: false } };
            await writeUnified(unified);

            await new ClaudeProvider().enableServer("serena", null);

            expect(readClaudeJson().mcpServers?.serena).toBeDefined();
            expect(logger.warn).not.toHaveBeenCalled();
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

    describe("sync and project lists", () => {
        /** Lists that hold old sweep entries, a project with no list, and an override project. */
        const projectsFixture = () => ({
            "/proj/a": { mcpServers: {}, disabledMcpServers: ["github", "serena"], history: ["precious"] },
            "/proj/b": { mcpServers: {}, disabledMcpServers: [] },
            "/proj/c": { mcpServers: {} },
            "/proj/o": { mcpServers: { serena: { type: "stdio", command: "old" } }, disabledMcpServers: [] },
        });

        it("a boolean or unset claude state changes no project list, even when the server gets installed", async () => {
            // github is enabled but not installed, so the sync command runs installServer for it.
            writeClaudeJson({ numStartups: 5, mcpServers: {}, disabledMcpServers: [], projects: projectsFixture() });
            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = { enabled: { claude: false } };
            unified.mcpServers.unset = { type: "stdio", command: "unset-mcp" };
            await writeUnified(unified);

            await syncServers([new ClaudeProvider()], { provider: "claude" });

            const claude = readClaudeJson();
            expect(claude.mcpServers?.github).toBeDefined(); // the sync really ran
            expect(claude.mcpServers?.unset).toBeDefined();
            expect(claude.mcpServers?.serena).toBeUndefined();
            // The only project change: the override entry is refreshed from the unified config.
            const expected = {
                ...projectsFixture(),
                "/proj/o": { mcpServers: { serena: { ...SERENA } }, disabledMcpServers: [] },
            };
            expect(claude.projects).toEqual(expected as ClaudeGenericConfig["projects"]);
        });

        it("a per-project map writes only the projects it names", async () => {
            writeClaudeJson({
                mcpServers: { serena: { ...SERENA }, github: { ...GITHUB } },
                projects: projectsFixture(),
            });
            const unified = unifiedFixture();
            unified.mcpServers.serena._meta = {
                enabled: { claude: { "/proj/a": true, "/proj/b": false, "/proj/o": false, "/proj/missing": false } },
            };
            await writeUnified(unified);

            await new ClaudeProvider().syncServers((await readUnified()).mcpServers);

            const projects = readClaudeJson().projects ?? {};
            expect(projects["/proj/a"].disabledMcpServers).toEqual(["github"]); // true: taken off
            expect(projects["/proj/b"].disabledMcpServers).toEqual(["serena"]); // false: put on
            expect(projects["/proj/c"]).toEqual({ mcpServers: {} }); // not named: no list created
            expect(projects["/proj/o"].disabledMcpServers).toEqual([]); // override wins over the map
            expect(projects["/proj/missing"]).toBeUndefined(); // never created
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

    describe("plugin-provided servers", () => {
        const PLUGIN_URL = "https://mcp.example.test/mcp";

        const settingsPath = () => join(homeDir, ".claude", "settings.json");

        /**
         * Two enabled plugins that share the short name `expo` (one server, one denylist entry),
         * one disabled plugin, and a user settings file with unrelated keys that must survive.
         */
        const seedClaudePlugins = (settings: Record<string, unknown> = {}): string => {
            const pluginsDir = join(homeDir, ".claude", "plugins");
            const userCopy = join(pluginsDir, "cache", "market", "expo", "1.2.0");
            const projectCopy = join(pluginsDir, "cache", "market", "expo", "1.0.0");
            const otherCopy = join(pluginsDir, "cache", "other", "expo", "2.0.0");
            const offCopy = join(pluginsDir, "cache", "market", "off", "1.0.0");
            mkdirSync(join(userCopy, ".claude-plugin"), { recursive: true });
            mkdirSync(projectCopy, { recursive: true });
            mkdirSync(join(otherCopy, ".claude-plugin"), { recursive: true });
            mkdirSync(offCopy, { recursive: true });
            writeFileSync(join(userCopy, ".mcp.json"), `{"mcpServers":{"expo":{"type":"http","url":"${PLUGIN_URL}"}}}`);
            writeFileSync(join(projectCopy, ".mcp.json"), '{"mcpServers":{"stale":{"command":"stale"}}}');
            writeFileSync(
                join(otherCopy, ".claude-plugin", "plugin.json"),
                `{"name":"expo","mcpServers":{"expo":{"type":"http","url":"${PLUGIN_URL}"}}}`
            );
            writeFileSync(join(offCopy, "mcp.json"), '{"mcpServers":{"off":{"command":"off"}}}');
            writeFileSync(
                join(pluginsDir, "installed_plugins.json"),
                SafeJSON.stringify(
                    {
                        version: 2,
                        plugins: {
                            "expo@market": [
                                { scope: "local", projectPath: "/proj/a", installPath: projectCopy },
                                { scope: "user", installPath: userCopy },
                            ],
                            "expo@other": [{ scope: "user", installPath: otherCopy }],
                            "off@market": [{ scope: "user", installPath: offCopy }],
                        },
                    },
                    null,
                    2
                )
            );

            const text = `${SafeJSON.stringify(
                {
                    theme: "dark",
                    permissions: { allow: ["Bash(ls)"] },
                    enabledPlugins: { "expo@market": true, "expo@other": true, "off@market": false },
                    ...settings,
                },
                null,
                2
            )}\n`;
            writeFileSync(settingsPath(), text);
            return text;
        };

        const readSettings = (): Record<string, unknown> =>
            SafeJSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;

        const seedCodexPlugin = (): void => {
            const codexHome = join(homeDir, ".codex");
            const pluginDir = join(codexHome, "plugins", "cache", "market", "expo", "1.2.0");
            mkdirSync(pluginDir, { recursive: true });
            writeFileSync(
                join(pluginDir, ".mcp.json"),
                `{"mcpServers":{"expo":{"type":"http","url":"${PLUGIN_URL}"}}}`
            );
            writeFileSync(join(codexHome, "config.toml"), '[plugins."expo@market"]\nenabled = true\n');
        };

        const readCodexText = (): string => readFileSync(join(homeDir, ".codex", "config.toml"), "utf-8");

        /** Grok loads the Claude-enabled expo plugin through its Claude compatibility; nothing names it in Grok's own file. */
        const seedGrokConfig = (): string => {
            const text = TOML.stringify({ disabled_mcp_servers: ["pencil"] });
            mkdirSync(join(homeDir, ".grok"), { recursive: true });
            writeFileSync(join(homeDir, ".grok", "config.toml"), text);
            return text;
        };

        const readGrok = () =>
            TOML.parse(readFileSync(join(homeDir, ".grok", "config.toml"), "utf-8")) as {
                disabled_mcp_servers?: string[];
                mcp_servers?: Record<string, unknown>;
            };

        it("lists only the servers of enabled plugins, from the user-scope install", async () => {
            seedClaudePlugins();

            const servers = await new ClaudeProvider().listPluginServers();

            expect(servers.map((server) => `${server.plugin}:${server.name}:${server.enabled}`).sort()).toEqual([
                "expo@market:expo:true",
                "expo@other:expo:true",
            ]);
            expect(servers[0]?.config).toEqual({ type: "http", url: PLUGIN_URL });
        });

        it("a full disk during a plugin toggle preserves all settings and cleans up the temp file", async () => {
            const original = seedClaudePlugins();
            const provider = new ClaudeProvider();
            const path = settingsPath();
            const before = readdirSync(join(homeDir, ".claude")).sort();
            const write = spyOn(atomicWriteIo, "writeSync").mockImplementation((fd, bytes, offset, length) => {
                writeSync(fd, bytes, offset, Math.floor(length / 2));
                throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
            });
            try {
                await expect(provider.setPluginServersEnabled(["expo"], false)).rejects.toThrow("fixture disk full");
                expect(write).toHaveBeenCalledTimes(1);
                expect(readFileSync(path, "utf8")).toBe(original);
                expect(readdirSync(join(homeDir, ".claude")).sort()).toEqual(before);
            } finally {
                write.mockRestore();
            }

            expect(await provider.setPluginServersEnabled(["expo"], false)).toBe(WriteResult.Applied);
            expect(readSettings().deniedMcpServers).toEqual([{ serverName: "plugin:expo:expo" }]);
            expect(readSettings().theme).toBe("dark");
            expect(statSync(path).mode & 0o777).toBe(0o600);
        });

        it("disable adds one deniedMcpServers entry and keeps the rest; enable restores the file", async () => {
            const original = seedClaudePlugins();
            const provider = new ClaudeProvider();

            expect(await provider.setPluginServersEnabled(["expo"], false)).toBe(WriteResult.Applied);

            const settings = readSettings();
            expect(settings.deniedMcpServers).toEqual([{ serverName: "plugin:expo:expo" }]);
            expect(settings.theme).toBe("dark");
            expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
            expect(readFileSync(settingsPath(), "utf-8").endsWith("}\n")).toBe(true);
            expect((await provider.listPluginServers()).every((server) => !server.enabled)).toBe(true);
            expect(await provider.setPluginServersEnabled(["expo"], false)).toBe(WriteResult.NoChanges);
            // The plugin itself stays enabled, and ~/.claude.json is not touched.
            expect(readSettings().enabledPlugins).toMatchObject({ "expo@market": true, "expo@other": true });

            expect(await provider.setPluginServersEnabled(["expo"], true)).toBe(WriteResult.Applied);
            expect(readFileSync(settingsPath(), "utf-8")).toBe(original);
        });

        it("enable removes only its own entry and keeps a deny entry it did not write", async () => {
            seedClaudePlugins({
                deniedMcpServers: [{ serverUrl: "https://elsewhere.test/*" }, { serverName: "plugin:expo:expo" }],
            });
            const provider = new ClaudeProvider();

            expect((await provider.listPluginServers()).every((server) => !server.enabled)).toBe(true);
            await provider.setPluginServersEnabled(["expo"], true);

            expect(readSettings().deniedMcpServers).toEqual([{ serverUrl: "https://elsewhere.test/*" }]);
        });

        it("disable/enable commands switch the plugin server in Claude, Codex and Grok, and sync keeps every switch", async () => {
            writeClaudeJson(claudeFixture());
            const unified = unifiedFixture();
            // grok false: the Grok sync writes a disabled table. github has no grok decision: no table.
            unified.mcpServers.serena._meta = { enabled: { claude: true, codex: true, grok: false } };
            await writeUnified(unified);
            const original = seedClaudePlugins();
            seedCodexPlugin();
            seedGrokConfig();
            const providers = () => [new ClaudeProvider(), new CodexProvider(), new GrokProvider()];

            await disableCommand("expo", providers(), {});

            expect(readGrok().disabled_mcp_servers).toEqual(["pencil", "expo"]);
            expect(readGrok().mcp_servers?.expo).toBeUndefined();

            expect(readSettings().deniedMcpServers).toEqual([{ serverName: "plugin:expo:expo" }]);
            const codex = TOML.parse(readCodexText()) as {
                mcp_servers?: Record<string, unknown>;
                plugins?: Record<string, unknown>;
            };
            expect(codex.plugins?.["expo@market"]).toEqual({
                enabled: true,
                mcp_servers: { expo: { enabled: false } },
            });
            expect(readCodexText()).not.toMatch(/^\[mcp_servers\.expo\]/m);
            // A plugin server never enters the unified config or ~/.claude.json.
            expect((await readUnified()).mcpServers.expo).toBeUndefined();
            expect(readClaudeJson().mcpServers?.expo).toBeUndefined();

            await syncServers(providers(), { provider: "all" });

            expect(readClaudeJson().mcpServers?.serena).toBeDefined(); // the sync really ran
            expect(readSettings().deniedMcpServers).toEqual([{ serverName: "plugin:expo:expo" }]);
            const synced = TOML.parse(readCodexText()) as {
                mcp_servers?: Record<string, unknown>;
                plugins?: Record<string, unknown>;
            };
            expect(synced.mcp_servers?.serena).toBeDefined();
            expect(synced.mcp_servers?.expo).toBeUndefined();
            expect(readGrok().mcp_servers?.serena).toEqual({ command: "uvx", args: ["serena"], enabled: false });
            expect(readGrok().mcp_servers?.github).toBeUndefined();
            expect(readGrok().disabled_mcp_servers).toEqual(["pencil", "expo"]);
            expect(readGrok().mcp_servers?.expo).toBeUndefined();
            expect(synced.plugins?.["expo@market"]).toEqual({
                enabled: true,
                mcp_servers: { expo: { enabled: false } },
            });

            await enableCommand("expo", providers(), {});

            expect(readFileSync(settingsPath(), "utf-8")).toBe(original);
            const enabled = TOML.parse(readCodexText()) as { plugins?: Record<string, unknown> };
            expect(enabled.plugins?.["expo@market"]).toEqual({ enabled: true });
            expect(readGrok().disabled_mcp_servers).toEqual(["pencil"]);
        });

        it("enable -p grok of a server Grok takes from ~/.claude.json writes no Grok copy", async () => {
            writeClaudeJson(claudeFixture()); // github is in ~/.claude.json mcpServers
            await writeUnified(unifiedFixture()); // github has no grok decision yet
            const grok = seedGrokConfig();

            await enableCommand("github", [new GrokProvider()], { provider: "grok" });

            expect(readFileSync(join(homeDir, ".grok", "config.toml"), "utf-8")).toBe(grok);
            expect((await readUnified()).mcpServers.github._meta?.enabled?.grok).toBe(true);
        });

        it("-p grok switches the plugin server in Grok only", async () => {
            writeClaudeJson(claudeFixture());
            await writeUnified(unifiedFixture());
            const settings = seedClaudePlugins();
            const grok = seedGrokConfig();
            const providers = () => [new ClaudeProvider(), new GrokProvider()];

            await disableCommand("expo", providers(), { provider: "grok" });

            expect(readGrok().disabled_mcp_servers).toEqual(["pencil", "expo"]);
            expect(readFileSync(settingsPath(), "utf-8")).toBe(settings); // Claude untouched

            await enableCommand("expo", providers(), { provider: "grok" });

            expect(readFileSync(join(homeDir, ".grok", "config.toml"), "utf-8")).toBe(grok);
        });
    });
});
