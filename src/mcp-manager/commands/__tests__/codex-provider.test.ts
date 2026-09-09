import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGlobalOptions } from "@app/mcp-manager/utils/config.utils.js";
import { CodexProvider } from "@app/mcp-manager/utils/providers/codex.js";
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
        expect(config.mcp_servers?.jina).toEqual({
            type: "http",
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
            type: "http",
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
