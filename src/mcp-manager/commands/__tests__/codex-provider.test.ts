import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGlobalOptions } from "@app/mcp-manager/utils/config.utils.js";
import { CodexProvider } from "@app/mcp-manager/utils/providers/codex.js";
import { WriteResult } from "@app/mcp-manager/utils/providers/types.js";
import { env } from "@genesiscz/utils/env";
import * as TOML from "@iarna/toml";

describe("CodexProvider remote HTTP authentication", () => {
    let homeDir: string;
    let previousHome: string | undefined;

    beforeEach(() => {
        previousHome = env.get("HOME");
        homeDir = mkdtempSync(join(tmpdir(), "mcp-codex-provider-"));
        env.testing.set("HOME", homeDir);
        setGlobalOptions({ yes: true });
    });

    afterEach(() => {
        if (previousHome !== undefined) {
            env.testing.set("HOME", previousHome);
        } else {
            env.testing.unset("HOME");
        }
        setGlobalOptions({});
        rmSync(homeDir, { recursive: true, force: true });
    });

    it("writes unified HTTP headers using Codex's supported table", async () => {
        // Regression test: user report 2026-09-02 — mcp-manager emitted `headers`, which Codex ignored.
        const provider = new CodexProvider();

        await provider.syncServers({
            jina: {
                type: "http",
                url: "https://mcp.jina.ai/v1",
                headers: { Authorization: "Bearer test-jina-key" },
                _meta: { enabled: { codex: true } },
            },
        });

        const config = TOML.parse(readFileSync(join(homeDir, ".codex", "config.toml"), "utf-8")) as {
            mcp_servers?: Record<string, unknown>;
        };
        // No `type` either: Codex has no such key and logged every one as an unrecognized setting.
        expect(config.mcp_servers?.jina).toEqual({
            url: "https://mcp.jina.ai/v1",
            http_headers: { Authorization: "Bearer test-jina-key" },
        });
    });

    it("reads Codex HTTP headers into the unified configuration", async () => {
        // Regression test: user report 2026-09-02 — sync could not recover authentication from Codex.
        mkdirSync(join(homeDir, ".codex"), { recursive: true });
        await Bun.write(
            join(homeDir, ".codex", "config.toml"),
            `[mcp_servers.jina]
url = "https://mcp.jina.ai/v1"

[mcp_servers.jina.http_headers]
Authorization = "Bearer test-jina-key"
`
        );
        const provider = new CodexProvider();

        const config = await provider.getServerConfig("jina");

        expect(config?.headers).toEqual({ Authorization: "Bearer test-jina-key" });
    });

    // PR #374 review: syncFromHomes was assigned and never read, so the configured
    // `harnesses.codex.syncFrom.homes` list changed nothing.
    it("reads servers from every configured syncFrom home, first home winning a name clash", async () => {
        const primary = join(homeDir, ".codex");
        const extra = join(homeDir, ".codex-shop");
        mkdirSync(primary, { recursive: true });
        mkdirSync(extra, { recursive: true });
        await Bun.write(join(primary, "config.toml"), '[mcp_servers.shared]\ncommand = "from-primary"\n');
        await Bun.write(
            join(extra, "config.toml"),
            '[mcp_servers.shared]\ncommand = "from-shop"\n\n[mcp_servers.shop_only]\ncommand = "peekaboo"\n'
        );

        const primaryOnly = new CodexProvider({ syncToHomes: [primary, extra], syncFromHomes: [primary] });
        expect((await primaryOnly.listServers()).map((s) => s.name)).toEqual(["shared"]);
        expect(await primaryOnly.getServerConfig("shop_only")).toBeNull();

        const both = new CodexProvider({ syncToHomes: [primary, extra], syncFromHomes: [primary, extra] });
        expect((await both.listServers()).map((s) => s.name).sort()).toEqual(["shared", "shop_only"]);
        expect((await both.getServerConfig("shared"))?.command).toBe("from-primary");
        expect((await both.getServerConfig("shop_only"))?.command).toBe("peekaboo");
        // Reads reaching the shop home must not move writes there.
        expect(both.getConfigPath()).toBe(join(primary, "config.toml"));
    });

    it("a disabled server is removed from every home the sync writes to", async () => {
        // Codex has no disabled state, so `listServers` reports whatever it finds as enabled.
        // Deleting a disabled server from the primary home only left it in the extra home, the
        // next `sync-from` read it back as enabled, and the following `sync` reinstalled it —
        // a disable that never stuck.
        const primary = join(homeDir, ".codex");
        const extra = join(homeDir, ".codex-shop");
        mkdirSync(primary, { recursive: true });
        mkdirSync(extra, { recursive: true });
        await Bun.write(
            join(primary, "config.toml"),
            '[mcp_servers.browsermcp]\ncommand = "browsermcp"\n\n[mcp_servers.keep]\ncommand = "keep"\n'
        );
        await Bun.write(
            join(extra, "config.toml"),
            '[mcp_servers.browsermcp]\ncommand = "browsermcp"\n\n[mcp_servers.shop_only]\ncommand = "peekaboo"\n'
        );

        const provider = new CodexProvider({ syncToHomes: [primary, extra], syncFromHomes: [primary, extra] });

        await provider.syncServers({
            browsermcp: { command: "browsermcp", _meta: { enabled: { codex: false } } },
            keep: { command: "keep", _meta: { enabled: { codex: true } } },
        });

        const read = (home: string) =>
            (TOML.parse(readFileSync(join(home, "config.toml"), "utf-8")) as { mcp_servers?: Record<string, unknown> })
                .mcp_servers ?? {};

        expect(read(primary).browsermcp).toBeUndefined();
        expect(read(extra).browsermcp).toBeUndefined();
        // Negative controls: the enabled server lands, and a server only the extra home knows
        // about is never touched by a disable it was not named in.
        expect(read(primary).keep).toMatchObject({ command: "keep" });
        expect(read(extra).keep).toMatchObject({ command: "keep" });
        expect(read(extra).shop_only).toMatchObject({ command: "peekaboo" });
    });

    it("writes enabled HTTP servers to extra homes without replacing a home-bound dest server", async () => {
        const primary = join(homeDir, ".codex");
        const extra = join(homeDir, ".codex-shop");
        mkdirSync(primary, { recursive: true });
        mkdirSync(extra, { recursive: true });
        await Bun.write(
            join(extra, "config.toml"),
            `[mcp_servers.jina]
type = "http"
url = "https://mcp.jina.ai/v1"

[mcp_servers.jina.headers]
Authorization = "Bearer dest-key"

[mcp_servers.node_repl]
command = "node_repl"

[mcp_servers.node_repl.env]
CODEX_HOME = "${extra}"

[mcp_servers.peekaboo]
command = "peekaboo"
`
        );

        const provider = new CodexProvider({
            syncToHomes: [primary, extra],
            syncFromHomes: [primary],
        });

        await provider.syncServers({
            jina: {
                type: "http",
                url: "https://mcp.jina.ai/v1",
                headers: { Authorization: "Bearer unified-key" },
                _meta: { enabled: { codex: true } },
            },
            node_repl: {
                command: "node_repl",
                env: { CODEX_HOME: primary },
                _meta: { enabled: { codex: true } },
            },
        });

        const extraConfig = TOML.parse(readFileSync(join(extra, "config.toml"), "utf-8")) as {
            mcp_servers?: Record<string, unknown>;
        };
        expect(extraConfig.mcp_servers?.jina).toEqual({
            url: "https://mcp.jina.ai/v1",
            http_headers: { Authorization: "Bearer unified-key" },
        });
        expect(extraConfig.mcp_servers?.node_repl).toEqual({
            command: "node_repl",
            env: { CODEX_HOME: extra },
        });
        expect(extraConfig.mcp_servers?.peekaboo).toEqual({ command: "peekaboo" });
    });
});

describe("CodexProvider plugin-provided MCP servers", () => {
    let homeDir: string;
    let previousHome: string | undefined;

    beforeEach(() => {
        previousHome = env.get("HOME");
        homeDir = mkdtempSync(join(tmpdir(), "mcp-codex-plugins-"));
        env.testing.set("HOME", homeDir);
        setGlobalOptions({ yes: true });
    });

    afterEach(() => {
        if (previousHome !== undefined) {
            env.testing.set("HOME", previousHome);
        } else {
            env.testing.unset("HOME");
        }
        setGlobalOptions({});
        rmSync(homeDir, { recursive: true, force: true });
    });

    /** A Codex home whose config.toml names the `expo@market` plugin, with two cached plugin versions. */
    async function seedHome(home: string, plugin: { enabled: boolean } | null): Promise<string> {
        const cache = join(home, "plugins", "cache", "market", "expo");
        // 1.10.0 must win over 1.9.0: version folders sort by number, not by text.
        mkdirSync(join(cache, "1.9.0"), { recursive: true });
        await Bun.write(join(cache, "1.9.0", "mcp.json"), '{"mcpServers":{"old_server":{"command":"old"}}}');
        mkdirSync(join(cache, "1.10.0", ".codex-plugin"), { recursive: true });
        await Bun.write(
            join(cache, "1.10.0", ".codex-plugin", "plugin.json"),
            '{"name":"expo","mcpServers":"./.mcp.json"}'
        );
        await Bun.write(
            join(cache, "1.10.0", ".mcp.json"),
            '{"mcpServers":{"expo":{"type":"http","url":"https://mcp.example.test/mcp"}}}'
        );

        const config: TOML.JsonMap = { model: "gpt-test", mcp_servers: { keep: { command: "keep" } } };
        if (plugin) {
            config.plugins = { "expo@market": { enabled: plugin.enabled } };
        }

        const text = TOML.stringify(config);
        await Bun.write(join(home, "config.toml"), text);
        return text;
    }

    const readToml = (home: string) =>
        TOML.parse(readFileSync(join(home, "config.toml"), "utf-8")) as {
            mcp_servers?: Record<string, unknown>;
            plugins?: Record<string, { enabled?: boolean; mcp_servers?: Record<string, { enabled?: boolean }> }>;
        };

    it("discovers syncFrom-only plugin homes without writing their overrides", async () => {
        const primary = join(homeDir, "primary");
        const source = join(homeDir, "source");
        await seedHome(primary, { enabled: true });
        const original = await seedHome(source, { enabled: true });
        const provider = new CodexProvider({ syncToHomes: [primary], syncFromHomes: [primary, source] });
        expect((await provider.listPluginServers()).map((row) => row.home)).toContain(source);
        await provider.setPluginServersEnabled(["expo"], false);
        expect(readToml(primary).plugins?.["expo@market"]?.mcp_servers?.expo).toEqual({ enabled: false });
        expect(readFileSync(join(source, "config.toml"), "utf8")).toBe(original);
    });

    it("lists the servers of an enabled plugin per home and skips a home where the plugin is off", async () => {
        const primary = join(homeDir, ".codex");
        const extra = join(homeDir, ".codex-shop");
        await seedHome(primary, { enabled: true });
        await seedHome(extra, { enabled: false });

        const provider = new CodexProvider({ syncToHomes: [primary, extra] });
        const servers = await provider.listPluginServers();

        expect(servers).toEqual([
            {
                name: "expo",
                config: { type: "http", url: "https://mcp.example.test/mcp" },
                enabled: true,
                provider: "codex",
                plugin: "expo@market",
                home: primary,
            },
        ]);
        // Plugin servers are not unified-config servers: sync-from-providers must never import them.
        expect((await provider.listServers()).map((server) => server.name)).toEqual(["keep"]);
    });

    it("disable writes the per-plugin override in every home with the plugin, and enable restores the file", async () => {
        const primary = join(homeDir, ".codex");
        const extra = join(homeDir, ".codex-shop");
        const without = join(homeDir, ".codex-bare");
        const primaryText = await seedHome(primary, { enabled: true });
        const extraText = await seedHome(extra, { enabled: true });
        const withoutText = await seedHome(without, null);
        const provider = new CodexProvider({ syncToHomes: [primary, extra, without] });

        expect(await provider.setPluginServersEnabled(["expo"], false)).toBe(WriteResult.Applied);

        for (const home of [primary, extra]) {
            const config = readToml(home);
            expect(config.plugins?.["expo@market"]).toEqual({
                enabled: true,
                mcp_servers: { expo: { enabled: false } },
            });
            // A bare [mcp_servers.expo] has no transport and stops Codex from starting.
            expect(config.mcp_servers?.expo).toBeUndefined();
            expect(readFileSync(join(home, "config.toml"), "utf-8")).not.toMatch(/^\[mcp_servers\.expo\]/m);
        }

        expect(readFileSync(join(without, "config.toml"), "utf-8")).toBe(withoutText);
        expect((await provider.listPluginServers()).map((server) => server.enabled)).toEqual([false, false]);
        expect(await provider.setPluginServersEnabled(["expo"], false)).toBe(WriteResult.NoChanges);

        expect(await provider.setPluginServersEnabled(["expo"], true)).toBe(WriteResult.Applied);
        expect(readFileSync(join(primary, "config.toml"), "utf-8")).toBe(primaryText);
        expect(readFileSync(join(extra, "config.toml"), "utf-8")).toBe(extraText);
    });

    it("sync keeps the plugin override and the plugin table", async () => {
        const primary = join(homeDir, ".codex");
        await seedHome(primary, { enabled: true });
        const provider = new CodexProvider({ syncToHomes: [primary] });
        await provider.setPluginServersEnabled(["expo"], false);

        await provider.syncServers({
            keep: { command: "keep", _meta: { enabled: { codex: true } } },
            added: { command: "added", _meta: { enabled: { codex: true } } },
        });

        const config = readToml(primary);
        expect(config.mcp_servers?.added).toEqual({ command: "added" });
        expect(config.plugins?.["expo@market"]?.mcp_servers?.expo).toEqual({ enabled: false });
        expect(config.mcp_servers?.expo).toBeUndefined();
    });
});
