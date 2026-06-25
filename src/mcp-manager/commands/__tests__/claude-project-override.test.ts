import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";
import { setupInquirerMock } from "./inquirer-mock.js";

// Setup prompt mock + storage sandbox BEFORE importing modules under test
setupInquirerMock();
setupStorageSandbox();

const { ClaudeProvider } = await import("@app/mcp-manager/utils/providers/claude.js");
const { CursorProvider } = await import("@app/mcp-manager/utils/providers/cursor.js");
const { syncServers } = await import("../sync.js");
const { syncFromProviders } = await import("../sync-from-providers.js");
const { disableServer: disableCommand } = await import("../disable.js");
const { enableServer: enableCommand } = await import("../enable.js");

import { logger } from "@app/logger";
import { setGlobalOptions } from "@app/mcp-manager/utils/config.utils.js";
import type { ClaudeGenericConfig } from "@app/mcp-manager/utils/providers/claude.types.js";
import type { UnifiedMCPConfig, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage";

/**
 * Fixture tests for the per-project ENABLE OVERRIDE of a globally-disabled
 * server (claude): `enable <server> -p claude --project <path>` installs a
 * project-scope entry at `.projects[<path>].mcpServers.<name>` (which Claude
 * Code honors — same storage as `claude mcp add -s local`) while the global
 * state stays disabled (`_meta.enabled.claude === false`, absent from global
 * mcpServers). The override must survive global-disable sweeps and `sync`.
 */

const SERENA: UnifiedMCPServerConfig = { type: "stdio", command: "uvx", args: ["serena"] };
const GITHUB: UnifiedMCPServerConfig = { type: "stdio", command: "bunx", args: ["github-mcp"] };

describe("claude per-project enable override for globally-disabled servers", () => {
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

    /** serena globally disabled (absent + swept), github installed/enabled */
    const globallyDisabledFixture = () => ({
        mcpServers: { github: { ...GITHUB } },
        disabledMcpServers: ["serena"],
        projects: {
            "/proj/a": { mcpServers: {}, disabledMcpServers: ["serena"] },
            "/proj/b": { mcpServers: {}, disabledMcpServers: ["serena"] },
        },
    });

    const unifiedFixture = (): UnifiedMCPConfig => ({
        mcpServers: {
            serena: { ...SERENA, _meta: { enabled: { claude: false } } },
            github: { ...GITHUB, _meta: { enabled: { claude: true } } },
        },
    });

    /** Install the serena override into /proj/a via the enable command */
    const installOverride = async (provider: InstanceType<typeof ClaudeProvider>) => {
        await enableCommand("serena", [provider], { provider: "claude", project: ["/proj/a"] });
    };

    beforeEach(() => {
        mock.restore(); // clear spies leaked from other test files (single bun process)
        prevHome = env.get("HOME");
        homeDir = mkdtempSync(join(tmpdir(), "mcp-claude-override-"));
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

    it("enable --project installs a project-scope entry and keeps the global disable", async () => {
        writeClaudeJson(globallyDisabledFixture());
        await writeUnified(unifiedFixture());

        const provider = new ClaudeProvider();
        await installOverride(provider);

        const claude = readClaudeJson();
        // Override installed where Claude Code reads it
        expect(claude.projects?.["/proj/a"].mcpServers?.serena).toBeDefined();
        expect(claude.projects?.["/proj/a"].mcpServers?.serena.command).toBe("uvx");
        // Name removed from THAT project's disabled list (it would defeat the entry)
        expect(claude.projects?.["/proj/a"].disabledMcpServers).not.toContain("serena");
        // Other project + global state untouched
        expect(claude.projects?.["/proj/b"].disabledMcpServers).toContain("serena");
        expect(claude.mcpServers?.serena).toBeUndefined(); // NOT reinstalled globally

        // Global state in the unified config stays disabled — the override is
        // tracked solely by the project-scope entry
        const unified = await readUnified();
        expect(unified.mcpServers.serena._meta?.enabled?.claude).toBe(false);
    });

    it("regular per-project enable of a globally-installed server does NOT create an override entry", async () => {
        writeClaudeJson({
            mcpServers: { github: { ...GITHUB } },
            disabledMcpServers: [],
            projects: { "/proj/a": { mcpServers: {}, disabledMcpServers: ["github"] } },
        });
        await writeUnified(unifiedFixture());

        const provider = new ClaudeProvider();
        await enableCommand("github", [provider], { provider: "claude", project: ["/proj/a"] });

        const claude = readClaudeJson();
        expect(claude.projects?.["/proj/a"].disabledMcpServers).not.toContain("github");
        expect(claude.projects?.["/proj/a"].mcpServers?.github).toBeUndefined(); // no project-scope copy
        expect(claude.mcpServers?.github).toBeDefined();
    });

    it("a later global disable sweep SKIPS projects with an override entry", async () => {
        writeClaudeJson(globallyDisabledFixture());
        await writeUnified(unifiedFixture());

        const provider = new ClaudeProvider();
        await installOverride(provider);

        // Re-run the global disable — the sweep must not clobber the override
        await provider.disableServer("serena", null);

        const claude = readClaudeJson();
        expect(claude.projects?.["/proj/a"].mcpServers?.serena).toBeDefined(); // entry kept
        expect(claude.projects?.["/proj/a"].disabledMcpServers).not.toContain("serena"); // not re-added
        expect(claude.projects?.["/proj/b"].disabledMcpServers).toContain("serena"); // sweep still works elsewhere
    });

    it("CRITICAL INVARIANT: the override survives `sync`", async () => {
        writeClaudeJson(globallyDisabledFixture());
        await writeUnified(unifiedFixture());

        const provider = new ClaudeProvider();
        await installOverride(provider);

        await syncServers([provider], { provider: "claude" });

        const claude = readClaudeJson();
        // Override entry kept (config refreshed from unified config)
        expect(claude.projects?.["/proj/a"].mcpServers?.serena).toBeDefined();
        expect(claude.projects?.["/proj/a"].mcpServers?.serena.command).toBe("uvx");
        // Name NOT re-added to the override project's disabled list
        expect(claude.projects?.["/proj/a"].disabledMcpServers).not.toContain("serena");
        // Global disable still enforced
        expect(claude.mcpServers?.serena).toBeUndefined();
        expect(claude.projects?.["/proj/b"].disabledMcpServers).toContain("serena");
        // Enabled sibling unaffected
        expect(claude.mcpServers?.github).toBeDefined();
    });

    it("sync-from-providers keeps _meta.enabled.claude === false despite the override", async () => {
        writeClaudeJson(globallyDisabledFixture());
        await writeUnified(unifiedFixture());

        const provider = new ClaudeProvider();
        await installOverride(provider);

        await syncFromProviders([provider], { provider: "claude" });

        const unified = await readUnified();
        expect(unified.mcpServers.serena).toBeDefined();
        expect(unified.mcpServers.serena.command).toBe("uvx");
        // Must stay boolean false — NOT flip to a per-project object, which
        // would make the next sync reinstall the server globally
        expect(unified.mcpServers.serena._meta?.enabled?.claude).toBe(false);
    });

    it("disable --project removes the override entry again", async () => {
        writeClaudeJson(globallyDisabledFixture());
        await writeUnified(unifiedFixture());

        const provider = new ClaudeProvider();
        await installOverride(provider);

        await disableCommand("serena", [provider], { provider: "claude", project: ["/proj/a"] });

        const claude = readClaudeJson();
        expect(claude.projects?.["/proj/a"].mcpServers?.serena).toBeUndefined(); // override gone
        expect(claude.projects?.["/proj/a"].disabledMcpServers).toContain("serena"); // back on the list

        const unified = await readUnified();
        expect(unified.mcpServers.serena._meta?.enabled?.claude).toBe(false); // global state untouched
    });

    it("listServers reports the global disable AND the per-project override", async () => {
        writeClaudeJson(globallyDisabledFixture());
        await writeUnified(unifiedFixture());

        const provider = new ClaudeProvider();
        await installOverride(provider);

        const servers = await provider.listServers();
        const serenaRows = servers.filter((s) => s.name === "serena");

        const globalRow = serenaRows.find((s) => s.provider === "claude");
        expect(globalRow).toBeDefined();
        expect(globalRow?.enabled).toBe(false); // disabled globally

        const overrideRow = serenaRows.find((s) => s.provider === "claude:/proj/a");
        expect(overrideRow).toBeDefined();
        expect(overrideRow?.enabled).toBe(true); // enabled in 1 project
    });

    it("-p all expands to all providers with configs (bonus fix)", async () => {
        writeClaudeJson(globallyDisabledFixture());
        await writeUnified(unifiedFixture());

        // Second provider with a config in the sandbox HOME, so "all" has to
        // expand beyond claude (a single-provider array can't prove expansion).
        mkdirSync(join(homeDir, ".cursor"), { recursive: true });
        writeFileSync(
            join(homeDir, ".cursor", "mcp.json"),
            SafeJSON.stringify({ mcpServers: { github: { command: "bunx", args: ["github-mcp"] } } }, null, 2)
        );

        const provider = new ClaudeProvider();
        const cursorProvider = new CursorProvider();
        await disableCommand("github", [provider, cursorProvider], { provider: "all" });

        const claude = readClaudeJson();
        expect(claude.mcpServers?.github).toBeUndefined(); // globally disabled = removed

        const cursor = SafeJSON.parse(readFileSync(join(homeDir, ".cursor", "mcp.json"), "utf-8")) as {
            mcpServers?: Record<string, unknown>;
        };
        expect(cursor.mcpServers?.github).toBeUndefined(); // cursor disable = entry removed

        const unified = await readUnified();
        expect(unified.mcpServers.github._meta?.enabled?.claude).toBe(false);
        expect(unified.mcpServers.github._meta?.enabled?.cursor).toBe(false);
    });
});
