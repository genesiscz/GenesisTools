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
});
