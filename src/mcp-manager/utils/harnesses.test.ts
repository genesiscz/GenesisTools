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
