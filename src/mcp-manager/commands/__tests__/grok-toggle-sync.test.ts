import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { setupInquirerMock } from "./inquirer-mock.js";

setupInquirerMock();
setupStorageSandbox();

const { GrokProvider } = await import("@app/mcp-manager/utils/providers/grok.js");
const { syncServers } = await import("../sync.js");
const { syncFromProviders } = await import("../sync-from-providers.js");
const { disableServer: disableCommand } = await import("../disable.js");
const { enableServer: enableCommand } = await import("../enable.js");

import { setGlobalOptions } from "@app/mcp-manager/utils/config.utils.js";
import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";

/**
 * Grok keeps disabled servers in config.toml with `enabled = false`. A later
 * sync must not read a present-but-disabled server as "turn it back on", and
 * must not drop `enabled = false` (a missing key is treated as enabled).
 */

const VITRINKA = { type: "stdio" as const, command: "vitrinka", args: ["mcp"] };
const CONTEXT7 = { type: "stdio" as const, command: "context7-mcp" };

describe("grok enable/disable survives sync", () => {
    let homeDir: string;
    let prevHome: string | undefined;

    const grokToml = () => join(homeDir, ".grok", "config.toml");

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
        mock.restore();
        prevHome = env.get("HOME");
        homeDir = mkdtempSync(join(tmpdir(), "mcp-grok-toggle-"));
        env.testing.set("HOME", homeDir);
        mkdirSync(join(homeDir, ".grok"), { recursive: true });
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

    it("disable and enable stick through sync and sync-from", async () => {
        writeFileSync(
            grokToml(),
            [
                "[features]",
                "beta = true",
                "",
                "[mcp_servers.vitrinka]",
                'command = "vitrinka"',
                "enabled = true",
                "",
            ].join("\n")
        );

        await writeUnified({
            mcpServers: {
                vitrinka: { ...VITRINKA, _meta: { enabled: { claude: true, codex: true, grok: true } } },
                "context7-mcp": { ...CONTEXT7, _meta: { enabled: { claude: true, codex: true, grok: false } } },
            },
        });

        const provider = new GrokProvider();

        await disableCommand("vitrinka", [provider], { provider: "grok" });
        await enableCommand("context7-mcp", [provider], { provider: "grok" });

        let unified = await readUnified();
        expect(unified.mcpServers.vitrinka._meta?.enabled?.grok).toBe(false);
        expect(unified.mcpServers["context7-mcp"]._meta?.enabled?.grok).toBe(true);
        // Other harnesses are not collateral.
        expect(unified.mcpServers.vitrinka._meta?.enabled?.claude).toBe(true);

        await syncServers([provider], { provider: "grok" });

        let toml = readFileSync(grokToml(), "utf-8");
        expect(toml).toContain("[features]");
        expect(toml).toContain("beta = true");
        expect(serverEnabled(toml, "vitrinka")).toBe(false);
        expect(serverEnabled(toml, "context7-mcp")).toBe(true);

        await syncFromProviders([provider], { provider: "grok" });

        unified = await readUnified();
        expect(unified.mcpServers.vitrinka._meta?.enabled?.grok).toBe(false);
        expect(unified.mcpServers.vitrinka.command).toBe("vitrinka");
        expect(unified.mcpServers["context7-mcp"]._meta?.enabled?.grok).toBe(true);
        expect(unified.mcpServers.vitrinka._meta?.enabled?.claude).toBe(true);

        await syncServers([provider], { provider: "grok" });

        toml = readFileSync(grokToml(), "utf-8");
        expect(serverEnabled(toml, "vitrinka")).toBe(false);
        expect(serverEnabled(toml, "context7-mcp")).toBe(true);
    });
});

function serverEnabled(toml: string, name: string): boolean | undefined {
    const block = toml.split(`[mcp_servers.${name}]`)[1]?.split(/\n\[/)[0] ?? "";
    const match = block.match(/^enabled = (true|false)/m);
    if (!match) {
        return undefined;
    }
    return match[1] === "true";
}
