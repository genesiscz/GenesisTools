import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_HEADER } from "@app/mcp-manager/lib/auth/constants.ts";
import { GrokProvider } from "./grok.ts";

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
