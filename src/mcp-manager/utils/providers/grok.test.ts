import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncConfigToProvider } from "@app/mcp-manager/commands/sync.ts";
import { GATEWAY_HEADER } from "@app/mcp-manager/lib/auth/constants.ts";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteIo } from "@genesiscz/utils/storage/atomic-file";
import * as TOML from "@iarna/toml";
import { GrokProvider } from "./grok.ts";
import { WriteResult } from "./types.ts";

/** The two protected fields a test has to reach to drive a write without a TTY. */
interface ProviderInternals {
    configPath: string;
    backupManager: { askConfirmation: () => Promise<boolean> };
}

function providerWritingTo(configPath: string): GrokProvider {
    const provider = new GrokProvider();
    const internals = provider as unknown as ProviderInternals;
    internals.configPath = configPath;
    internals.backupManager.askConfirmation = async () => true;

    return provider;
}

describe("GrokProvider.fromUnifiedConfig", () => {
    test("writes url plus headers, not Codex http_headers", () => {
        const provider = new GrokProvider();
        const projected = {
            rohlik: {
                type: "http" as const,
                url: "http://127.0.0.1:8318/mcp/rohlik",
                headers: { [GATEWAY_HEADER]: "local-token" },
                _meta: { enabled: { grok: true } },
            },
        };
        const grok = provider.fromUnifiedConfig(projected) as {
            mcp_servers: Record<string, Record<string, unknown>>;
        };

        expect(grok.mcp_servers.rohlik.url).toBe("http://127.0.0.1:8318/mcp/rohlik");
        expect(grok.mcp_servers.rohlik.headers).toEqual({ [GATEWAY_HEADER]: "local-token" });
        expect(grok.mcp_servers.rohlik.http_headers).toBeUndefined();
        expect(grok.mcp_servers.rohlik.enabled).toBe(true);
    });
});

describe("GrokProvider.syncServers", () => {
    let home: string;
    let previousHome: string | undefined;

    // A sync reads ~/.claude.json, ~/.cursor/mcp.json and Claude's plugins; keep them invented.
    beforeEach(() => {
        previousHome = env.get("HOME");
        home = mkdtempSync(join(tmpdir(), "grok-sync-home-"));
        env.testing.set("HOME", home);
    });

    afterEach(() => {
        if (previousHome !== undefined) {
            env.testing.set("HOME", previousHome);
        } else {
            env.testing.unset("HOME");
        }

        rmSync(home, { recursive: true, force: true });
    });

    const tomlAt = (configPath: string) =>
        TOML.parse(readFileSync(configPath, "utf-8")) as { mcp_servers?: Record<string, Record<string, unknown>> };

    /** A Grok config with one table per case, written by the provider's own TOML writer. */
    const seedGrok = (tables: Record<string, Record<string, unknown>>): string => {
        const configPath = join(home, ".grok", "config.toml");
        mkdirSync(join(home, ".grok"), { recursive: true });
        writeFileSync(configPath, TOML.stringify({ mcp_servers: tables } as TOML.JsonMap));
        return configPath;
    };

    const seedClaudeJson = (mcpServers: Record<string, unknown>) => {
        writeFileSync(join(home, ".claude.json"), SafeJSON.stringify({ mcpServers }, null, 2));
    };

    test("a server with no grok decision keeps its table exactly, and gets none when it has none", async () => {
        // Regression 2026-10-13: genesis-tools had `_meta.enabled` without grok; the sync wrote
        // `enabled = false` over a table Grok was running, extra capability header included.
        const own = {
            url: "http://127.0.0.1:8318/mcp/tool",
            headers: { "X-Capabilities": "a,b,extra" },
            enabled: true,
        };
        const configPath = seedGrok({ tool: own });
        const provider = providerWritingTo(configPath);

        await provider.syncServers({
            tool: { type: "http", url: "http://127.0.0.1:8318/mcp/tool", _meta: { enabled: { claude: true } } },
            fresh: { command: "fresh", _meta: { enabled: { claude: true } } },
        });

        expect(tomlAt(configPath).mcp_servers?.tool).toEqual(own);
        expect(tomlAt(configPath).mcp_servers?.fresh).toBeUndefined();
    });

    test("an enabled server Grok already loads from ~/.claude.json gets no copy; a different one does", async () => {
        seedClaudeJson({
            same: { type: "stdio", command: "same-mcp", args: ["--x"] },
            differs: { type: "stdio", command: "claude-build" },
            off: { type: "stdio", command: "off-mcp" },
        });
        const configPath = seedGrok({ keep: { command: "keep" } });
        const provider = providerWritingTo(configPath);

        await provider.syncServers({
            same: { command: "same-mcp", args: ["--x"], _meta: { enabled: { grok: true } } },
            differs: { command: "grok-build", _meta: { enabled: { grok: true } } },
            off: { command: "off-mcp", _meta: { enabled: { grok: false } } },
        });

        const tables = tomlAt(configPath).mcp_servers ?? {};
        expect(tables.same).toBeUndefined(); // Grok runs the ~/.claude.json copy already
        expect(tables.differs).toEqual({ command: "grok-build", enabled: true }); // wins over the Claude copy
        expect(tables.off).toEqual({ command: "off-mcp", enabled: false }); // a disabled table stops the Claude copy
        expect(tables.keep).toEqual({ command: "keep" });
    });

    test("disable and enable reach a server Grok takes from ~/.claude.json through the list, never a copy", async () => {
        seedClaudeJson({ brave: { type: "stdio", command: "brave" } });
        const configPath = join(home, ".grok", "config.toml");
        mkdirSync(join(home, ".grok"), { recursive: true });
        writeFileSync(
            configPath,
            TOML.stringify({ disabled_mcp_servers: ["own"], mcp_servers: { own: { command: "own", enabled: false } } })
        );
        const provider = providerWritingTo(configPath);

        await provider.disableServers(["brave"]);

        const off = TOML.parse(readFileSync(configPath, "utf-8")) as {
            disabled_mcp_servers?: string[];
            mcp_servers?: Record<string, unknown>;
        };
        expect(off.disabled_mcp_servers).toEqual(["own", "brave"]);
        expect(off.mcp_servers?.brave).toBeUndefined();
        expect((await provider.listCompatServers()).find((row) => row.name === "brave")?.enabled).toBe(false);

        await provider.enableServers(["brave", "own"]);

        const on = TOML.parse(readFileSync(configPath, "utf-8")) as {
            disabled_mcp_servers?: string[];
            mcp_servers?: Record<string, unknown>;
        };
        expect(on.disabled_mcp_servers).toBeUndefined(); // the list kept "own" off despite its table
        expect(on.mcp_servers).toEqual({ own: { command: "own", enabled: true } });
        await expect(provider.enableServers(["ghost"])).rejects.toThrow("Servers do not exist: ghost");
    });

    test("the sync command installs nothing up front for Grok", async () => {
        const configPath = seedGrok({ keep: { command: "keep" } });
        const provider = providerWritingTo(configPath);

        await syncConfigToProvider(
            { mcpServers: { unset: { command: "unset-mcp", _meta: { enabled: {} } } } },
            provider
        );

        expect(provider.shouldBeInstalled({ command: "x", _meta: { enabled: { grok: true } } })).toBe(false);
        expect(tomlAt(configPath).mcp_servers).toEqual({ keep: { command: "keep" } });
    });

    test("keeps every key that is not mcp_servers", async () => {
        const dir = mkdtempSync(join(tmpdir(), "grok-sync-"));
        const configPath = join(dir, "config.toml");
        // A miniature of the real file. Each of these sections was lost on
        // 2026-09-10 when a sync wrote a config built from nothing.
        await writeFile(
            configPath,
            [
                'disabled_mcp_servers = ["old-one"]',
                "",
                "[features]",
                "beta = true",
                "",
                "[telemetry]",
                "enabled = false",
                "",
                "[mcp_servers.stale]",
                'command = "gone"',
                "",
            ].join("\n"),
            "utf-8"
        );

        const provider = providerWritingTo(configPath);
        await provider.syncServers({
            rohlik: {
                type: "http",
                url: "http://127.0.0.1:8318/mcp/rohlik",
                headers: { [GATEWAY_HEADER]: "local-token" },
                _meta: { enabled: { grok: true } },
            },
        });

        const written = await readFile(configPath, "utf-8");

        expect(written).toContain("disabled_mcp_servers");
        expect(written).toContain("[features]");
        expect(written).toContain("[telemetry]");
        expect(written).toContain("rohlik");
        // Intended change 2026-10-13: a table the sync does not name stays, like in Claude and
        // Codex. Replacing the whole map made a one-server sync (`gateway`'s `only`) drop the rest.
        expect(written).toContain("[mcp_servers.stale]");
    });

    test.each([true, false])("config credentials are private before publication, existing=%s", async (existing) => {
        const dir = mkdtempSync(join(tmpdir(), "grok-mode-at-write-"));
        const configPath = join(dir, "config.toml");

        if (existing) {
            await writeFile(configPath, '[mcp_servers.old]\ncommand = "old"\n', { mode: 0o644 });
        }

        const modes: number[] = [];
        const write = atomicWriteIo.writeSync;
        const probe = spyOn(atomicWriteIo, "writeSync").mockImplementation((fd, bytes, offset, length) => {
            modes.push(fstatSync(fd).mode & 0o777);
            return write(fd, bytes, offset, length);
        });

        try {
            await providerWritingTo(configPath).syncServers({
                shop: {
                    type: "http",
                    url: "http://127.0.0.1:8318/mcp/shop",
                    headers: { [GATEWAY_HEADER]: "fixture-token" },
                    _meta: { enabled: { grok: true } },
                },
            });
        } finally {
            probe.mockRestore();
        }

        expect(modes.length).toBeGreaterThan(0);
        expect(modes.every((mode) => mode === 0o600)).toBe(true);
        expect((await stat(configPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(configPath, "utf8")).toContain("fixture-token");
    });

    test("writes the config 0600, because it now carries a gateway token", async () => {
        const dir = mkdtempSync(join(tmpdir(), "grok-mode-"));
        const configPath = join(dir, "config.toml");
        await writeFile(configPath, '[mcp_servers.stale]\ncommand = "gone"\n', { encoding: "utf-8", mode: 0o644 });

        const provider = providerWritingTo(configPath);
        await provider.syncServers({
            rohlik: {
                type: "http",
                url: "http://127.0.0.1:8318/mcp/rohlik",
                headers: { [GATEWAY_HEADER]: "local-token" },
                _meta: { enabled: { grok: true } },
            },
        });

        const info = await stat(configPath);

        expect(info.mode & 0o077).toBe(0);
    });
});

describe("GrokProvider plugin-provided MCP servers", () => {
    let home: string;
    let previousHome: string | undefined;

    beforeEach(() => {
        previousHome = env.get("HOME");
        home = mkdtempSync(join(tmpdir(), "grok-plugins-"));
        env.testing.set("HOME", home);
    });

    afterEach(() => {
        if (previousHome !== undefined) {
            env.testing.set("HOME", previousHome);
        } else {
            env.testing.unset("HOME");
        }

        rmSync(home, { recursive: true, force: true });
    });

    const writeJson = (file: string, value: unknown) => {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, SafeJSON.stringify(value, null, 2));
    };

    /**
     * Claude enables `expo@market` (Grok loads it through its Claude compatibility) and disables
     * `off@market`. Grok's own plugins: `team` from `[plugins].paths`, `devtools` from the registry
     * (enabled by ID, its server already on the disabled list) and `noisy-1` (enabled, but `[plugins].disabled` wins).
     * Returns the config text, written by the same TOML writer the provider uses.
     */
    const seed = (): string => {
        const claudeCache = join(home, ".claude", "plugins", "cache", "market");
        writeJson(join(home, ".claude", "settings.json"), {
            enabledPlugins: { "expo@market": true, "off@market": false },
        });
        writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
            version: 2,
            plugins: {
                "expo@market": [{ scope: "user", installPath: join(claudeCache, "expo", "1.0.0") }],
                "off@market": [{ scope: "user", installPath: join(claudeCache, "off", "1.0.0") }],
            },
        });
        writeJson(join(claudeCache, "expo", "1.0.0", ".mcp.json"), {
            mcpServers: { expo: { type: "http", url: "https://mcp.example.test/mcp" } },
        });
        writeJson(join(claudeCache, "off", "1.0.0", ".mcp.json"), { mcpServers: { off: { command: "off" } } });

        const team = join(home, "grok-plugins", "team");
        writeJson(join(team, ".claude-plugin", "plugin.json"), { name: "team" });
        writeJson(join(team, ".mcp.json"), { mcpServers: { "team-mcp": { command: "team" } } });
        const installed = join(home, ".grok", "installed-plugins");
        writeJson(join(installed, "devtools-1", ".claude-plugin", "plugin.json"), {
            name: "devtools",
            mcpServers: { "chrome-devtools": { command: "devtools" } },
        });
        writeJson(join(installed, "noisy-1", ".mcp.json"), { mcpServers: { "noisy-mcp": { command: "noisy" } } });
        writeJson(join(installed, "registry.json"), {
            version: 1,
            repos: {
                "devtools-1": { path: join(installed, "devtools-1"), plugins: { devtools: {} } },
                "noisy-1": { path: join(installed, "noisy-1"), plugins: { "noisy-1": {} } },
            },
        });

        const text = TOML.stringify({
            disabled_mcp_servers: ["pencil", "chrome-devtools"],
            mcp_servers: { keep: { command: "keep" } },
            plugins: { paths: [team], enabled: ["team", "user/abcd1234/devtools", "noisy-1"], disabled: ["noisy-1"] },
        });
        mkdirSync(join(home, ".grok"), { recursive: true });
        writeFileSync(join(home, ".grok", "config.toml"), text);
        return text;
    };

    const configPath = () => join(home, ".grok", "config.toml");
    const readConfig = () =>
        TOML.parse(readFileSync(configPath(), "utf-8")) as {
            disabled_mcp_servers?: string[];
            mcp_servers?: Record<string, unknown>;
            plugins?: unknown;
        };

    test("lists what Grok takes from ~/.claude.json and ~/.cursor/mcp.json, minus shadowed names", async () => {
        seed();
        writeFileSync(
            join(home, ".claude.json"),
            SafeJSON.stringify({
                mcpServers: {
                    "claude-only": { type: "stdio", command: "c" },
                    keep: { type: "stdio", command: "shadowed-by-table" },
                    expo: { type: "stdio", command: "shadowed-by-plugin" },
                    pencil: { type: "stdio", command: "on-the-disabled-list" },
                },
            })
        );
        writeJson(join(home, ".cursor", "mcp.json"), {
            mcpServers: { "cursor-only": { command: "k" }, "claude-only": { command: "loses-to-claude" } },
        });
        const provider = providerWritingTo(configPath());

        const rows = await provider.listCompatServers();

        expect(rows.map((r) => `${r.name}:${r.via}:${r.enabled}:${r.config.command}`).sort()).toEqual([
            "claude-only:~/.claude.json:true:c",
            "cursor-only:~/.cursor/mcp.json:true:k",
            "pencil:~/.claude.json:false:on-the-disabled-list",
        ]);
        expect((await provider.listServers()).map((r) => `${r.name}:${r.via}`)).toEqual(["keep:config.toml"]);

        // `[compat.claude] mcps = false` stops Grok reading ~/.claude.json: claude-only now comes from Cursor.
        const text = readFileSync(configPath(), "utf-8");
        writeFileSync(configPath(), `${text}\n[compat.claude]\nmcps = false\n`);
        expect((await provider.listCompatServers()).map((r) => `${r.name}:${r.via}`).sort()).toEqual([
            "claude-only:~/.cursor/mcp.json",
            "cursor-only:~/.cursor/mcp.json",
        ]);
    });

    test("lists Claude-enabled plugin servers and Grok's own enabled plugins", async () => {
        seed();

        const servers = await providerWritingTo(configPath()).listPluginServers();

        expect(servers.map((s) => `${s.plugin}:${s.name}:${s.enabled}`).sort()).toEqual([
            "devtools:chrome-devtools:false",
            "expo@market:expo:true",
            "team:team-mcp:true",
        ]);
    });

    test("disable adds the name to disabled_mcp_servers, never a table; enable restores the file", async () => {
        const original = seed();
        const provider = providerWritingTo(configPath());

        expect(await provider.setPluginServersEnabled(["expo"], false)).toBe(WriteResult.Applied);

        const config = readConfig();
        expect(config.disabled_mcp_servers).toEqual(["pencil", "chrome-devtools", "expo"]);
        // A bare [mcp_servers.expo] has no transport; the list is the whole switch.
        expect(config.mcp_servers).toEqual({ keep: { command: "keep" } });
        expect(readFileSync(configPath(), "utf-8")).not.toMatch(/^\[mcp_servers\.expo\]/m);
        expect(config.plugins).toBeDefined();
        expect((await provider.listPluginServers()).find((s) => s.name === "expo")?.enabled).toBe(false);
        expect(await provider.setPluginServersEnabled(["expo"], false)).toBe(WriteResult.NoChanges);

        expect(await provider.setPluginServersEnabled(["expo"], true)).toBe(WriteResult.Applied);
        expect(readFileSync(configPath(), "utf-8")).toBe(original);
    });

    test("sync keeps the plugin server on disabled_mcp_servers", async () => {
        seed();
        const provider = providerWritingTo(configPath());
        await provider.setPluginServersEnabled(["expo"], false);

        await provider.syncServers({ keep: { command: "keep", _meta: { enabled: { grok: true } } } });

        expect(readConfig().disabled_mcp_servers).toEqual(["pencil", "chrome-devtools", "expo"]);
        expect(readConfig().mcp_servers?.expo).toBeUndefined();
    });
});
