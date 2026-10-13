import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        // The servers themselves are still fully replaced by the sync.
        expect(written).toContain("rohlik");
        expect(written).not.toContain("stale");
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
