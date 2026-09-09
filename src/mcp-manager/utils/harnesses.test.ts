import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { ensureHarnessDefaults, mergeCodexServersForHome, resolveHarnessHomes } from "./harnesses.js";

describe("ensureHarnessDefaults", () => {
    it("fills every missing harness with the default tilde homes", () => {
        const { config, changed } = ensureHarnessDefaults({ mcpServers: {} });

        expect(changed).toBe(true);
        expect(config.harnesses).toEqual({
            claude: {
                syncTo: { homes: ["~/.claude.json"] },
                syncFrom: { homes: ["~/.claude.json"] },
            },
            gemini: {
                syncTo: { homes: ["~/.gemini/settings.json"] },
                syncFrom: { homes: ["~/.gemini/settings.json"] },
            },
            cursor: {
                syncTo: { homes: ["~/.cursor/mcp.json"] },
                syncFrom: { homes: ["~/.cursor/mcp.json"] },
            },
            codex: {
                syncTo: { homes: ["~/.codex"] },
                syncFrom: { homes: ["~/.codex"] },
            },
        });
    });

    it("keeps existing homes and fills only missing harnesses", () => {
        const { config, changed } = ensureHarnessDefaults({
            mcpServers: {},
            harnesses: {
                codex: {
                    syncTo: { homes: ["~/.codex", "~/.codex-shop"] },
                    syncFrom: { homes: ["~/.codex"] },
                },
            },
        });

        expect(changed).toBe(true);
        expect(config.harnesses?.codex).toEqual({
            syncTo: { homes: ["~/.codex", "~/.codex-shop"] },
            syncFrom: { homes: ["~/.codex"] },
        });
        expect(config.harnesses?.claude).toEqual({
            syncTo: { homes: ["~/.claude.json"] },
            syncFrom: { homes: ["~/.claude.json"] },
        });
    });
});

describe("mergeCodexServersForHome", () => {
    const primary = "/tmp/codex-primary";
    const shop = "/tmp/codex-shop";
    const allHomes = [primary, shop];

    it("replaces a dest HTTP server that still uses headers with incoming http_headers", () => {
        const next = mergeCodexServersForHome({
            dest: {
                jina: {
                    type: "http",
                    url: "https://mcp.jina.ai/v1",
                    headers: { Authorization: "Bearer dest-key" },
                },
            },
            incoming: {
                jina: {
                    type: "http",
                    url: "https://mcp.jina.ai/v1",
                    http_headers: { Authorization: "Bearer unified-key" },
                },
            },
            destHome: shop,
            allHomes,
        });

        expect(next.jina).toEqual({
            type: "http",
            url: "https://mcp.jina.ai/v1",
            http_headers: { Authorization: "Bearer unified-key" },
        });
    });

    it("keeps a dest server whose env names this home when incoming names another home", () => {
        const destNodeRepl = {
            command: "node_repl",
            env: { CODEX_HOME: shop },
        };
        const next = mergeCodexServersForHome({
            dest: { node_repl: destNodeRepl },
            incoming: {
                node_repl: {
                    command: "node_repl",
                    env: { CODEX_HOME: primary },
                },
            },
            destHome: shop,
            allHomes,
        });

        expect(next.node_repl).toEqual(destNodeRepl);
    });

    it("keeps dest-only servers that incoming does not mention", () => {
        const peekaboo = { command: "peekaboo", args: ["mcp", "serve"] };
        const next = mergeCodexServersForHome({
            dest: { peekaboo },
            incoming: {
                jina: {
                    type: "http",
                    url: "https://mcp.jina.ai/v1",
                    http_headers: { Authorization: "Bearer unified-key" },
                },
            },
            destHome: shop,
            allHomes,
        });

        expect(next.peekaboo).toEqual(peekaboo);
    });
});

describe("resolveHarnessHomes", () => {
    it("expands configured tilde homes against HOME", () => {
        const home = env.paths.getHome() || "";
        const { config } = ensureHarnessDefaults({
            mcpServers: {},
            harnesses: {
                codex: {
                    syncTo: { homes: ["~/.codex", "~/.codex-shop"] },
                    syncFrom: { homes: ["~/.codex"] },
                },
            },
        });

        expect(resolveHarnessHomes(config, "codex", "syncTo")).toEqual([
            join(home, ".codex"),
            join(home, ".codex-shop"),
        ]);
        expect(resolveHarnessHomes(config, "codex", "syncFrom")).toEqual([join(home, ".codex")]);
    });
});

// PR #374 review: `serverMentionsPath` was a substring test, so `~/.codex-shop`
// contained `~/.codex` and every shop-bound server was skipped for BOTH homes.
describe("mergeCodexServersForHome with prefix-colliding homes", () => {
    const primary = "/Users/x/.codex";
    const shop = "/Users/x/.codex-shop";
    const allHomes = [primary, shop];
    const shopBound = { command: "node_repl", env: { CODEX_HOME: shop } };
    const primaryBound = { command: "node_repl", env: { CODEX_HOME: primary } };

    it("writes a shop-bound server to the shop home", () => {
        const next = mergeCodexServersForHome({
            dest: {},
            incoming: { node_repl: shopBound },
            destHome: shop,
            allHomes,
        });

        expect(next.node_repl).toEqual(shopBound);
    });

    it("keeps a shop-bound server out of the primary home", () => {
        const next = mergeCodexServersForHome({
            dest: {},
            incoming: { node_repl: shopBound },
            destHome: primary,
            allHomes,
        });

        expect(next.node_repl).toBeUndefined();
    });

    it("does not treat a primary-bound dest server as bound to the shop home", () => {
        const next = mergeCodexServersForHome({
            dest: { node_repl: primaryBound },
            incoming: { node_repl: shopBound },
            destHome: shop,
            allHomes,
            protectHomeBound: true,
        });

        expect(next.node_repl).toEqual(shopBound);
    });

    it("still protects a genuinely dest-bound server", () => {
        const next = mergeCodexServersForHome({
            dest: { node_repl: shopBound },
            incoming: { node_repl: { command: "node_repl" } },
            destHome: shop,
            allHomes,
            protectHomeBound: true,
        });

        expect(next.node_repl).toEqual(shopBound);
    });

    it("matches a home nested inside a longer path, and inside a joined argument", () => {
        for (const incoming of [
            { command: "node_repl", args: [`${shop}/bin/serve`] },
            { command: "sh", args: ["-c", `CODEX_HOME=${shop} node_repl`] },
        ]) {
            expect(
                mergeCodexServersForHome({ dest: {}, incoming: { s: incoming }, destHome: primary, allHomes }).s
            ).toBeUndefined();
        }
    });
});
