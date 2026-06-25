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
const { GeminiProvider } = await import("@app/mcp-manager/utils/providers/gemini.js");
const { CodexProvider } = await import("@app/mcp-manager/utils/providers/codex.js");
const { removeServers } = await import("../remove.js");

import { logger } from "@app/logger";
import { setGlobalOptions } from "@app/mcp-manager/utils/config.utils.js";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage";
import * as TOML from "@iarna/toml";

/**
 * Fixture tests for the `remove` (purge) command: servers are removed
 * ENTIRELY — from every provider config and from the unified config.
 * All writes go to a temp HOME + sandboxed Storage; live configs are never
 * touched.
 */

const CODEX_TOML = `[notice]
seen = true

[projects."/Users/x/proj"]
trust_level = "trusted"

[mcp_servers.serena]
command = "uvx"
args = ["serena"]

[mcp_servers.serena.env]
FOO = "bar"

[mcp_servers.serena.http_headers]
Authorization = "Bearer x"

[mcp_servers.github]
command = "bunx"
args = ["github-mcp"]
`;

const UNIFIED_JSONC = `{
    "mcpServers": {
        "serena": {
            "type": "stdio",
            "command": "uvx",
            "args": ["serena"],
            "_meta": { "enabled": { "claude": false } }
        },
        // keep-me: precious user comment about github
        "github": {
            "type": "stdio",
            "command": "bunx",
            "args": ["github-mcp"],
            "_meta": { "enabled": { "claude": true } }
        }
    },
    "enabledMcpServers": {
        "serena": { "claude": false },
        "github": { "claude": true }
    }
}
`;

describe("remove command (permanent purge)", () => {
    let homeDir: string;
    let prevHome: string | undefined;

    const readJson = (path: string): Record<string, unknown> =>
        SafeJSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

    const writeFixtures = () => {
        // ~/.claude.json
        writeFileSync(
            join(homeDir, ".claude.json"),
            SafeJSON.stringify(
                {
                    numStartups: 7,
                    mcpServers: {
                        serena: { type: "stdio", command: "uvx", args: ["serena"] },
                        github: { type: "stdio", command: "bunx", args: ["github-mcp"] },
                    },
                    disabledMcpServers: ["serena"],
                    projects: {
                        "/proj/a": {
                            mcpServers: { serena: { type: "stdio", command: "uvx", args: ["serena"] } },
                            disabledMcpServers: ["serena", "other-history"],
                        },
                    },
                },
                null,
                2
            )
        );

        // ~/.cursor/mcp.json
        mkdirSync(join(homeDir, ".cursor"), { recursive: true });
        writeFileSync(
            join(homeDir, ".cursor", "mcp.json"),
            SafeJSON.stringify(
                {
                    mcpServers: {
                        serena: { command: "uvx", args: ["serena"] },
                        github: { command: "bunx", args: ["github-mcp"] },
                    },
                },
                null,
                2
            )
        );

        // ~/.gemini/settings.json
        mkdirSync(join(homeDir, ".gemini"), { recursive: true });
        writeFileSync(
            join(homeDir, ".gemini", "settings.json"),
            SafeJSON.stringify(
                {
                    theme: "dark",
                    mcpServers: {
                        serena: { command: "uvx", args: ["serena"] },
                        github: { command: "bunx", args: ["github-mcp"] },
                    },
                    mcp: { excluded: ["serena"] },
                },
                null,
                2
            )
        );

        // ~/.codex/config.toml
        mkdirSync(join(homeDir, ".codex"), { recursive: true });
        writeFileSync(join(homeDir, ".codex", "config.toml"), CODEX_TOML);

        // Unified config (raw JSONC with a user comment)
        const storage = new Storage("mcp-manager");
        mkdirSync(join(storage.getConfigPath(), ".."), { recursive: true });
        writeFileSync(storage.getConfigPath(), UNIFIED_JSONC);
    };

    beforeEach(() => {
        mock.restore(); // clear spies leaked from other test files (single bun process)
        prevHome = env.get("HOME");
        homeDir = mkdtempSync(join(tmpdir(), "mcp-remove-"));
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

    it("removes the server from all provider configs and the unified config", async () => {
        writeFixtures();
        const providers = [new ClaudeProvider(), new GeminiProvider(), new CodexProvider(), new CursorProvider()];

        await removeServers("serena", providers, {});

        // claude: global entry + top-level marker + project-scope entry gone;
        // per-project disabledMcpServers history lists untouched
        const claude = readJson(join(homeDir, ".claude.json")) as {
            numStartups: number;
            mcpServers: Record<string, unknown>;
            disabledMcpServers: string[];
            projects: Record<string, { mcpServers?: Record<string, unknown>; disabledMcpServers?: string[] }>;
        };
        expect(claude.mcpServers.serena).toBeUndefined();
        expect(claude.mcpServers.github).toBeDefined();
        expect(claude.disabledMcpServers).not.toContain("serena");
        expect(claude.projects["/proj/a"].mcpServers?.serena).toBeUndefined();
        expect(claude.projects["/proj/a"].disabledMcpServers).toEqual(["serena", "other-history"]); // untouched
        expect(claude.numStartups).toBe(7); // unrelated state preserved

        // cursor
        const cursor = readJson(join(homeDir, ".cursor", "mcp.json")) as { mcpServers: Record<string, unknown> };
        expect(cursor.mcpServers.serena).toBeUndefined();
        expect(cursor.mcpServers.github).toBeDefined();

        // gemini: mcpServers + mcp.excluded
        const gemini = readJson(join(homeDir, ".gemini", "settings.json")) as {
            theme: string;
            mcpServers: Record<string, unknown>;
            mcp: { excluded: string[] };
        };
        expect(gemini.mcpServers.serena).toBeUndefined();
        expect(gemini.mcpServers.github).toBeDefined();
        expect(gemini.mcp.excluded).not.toContain("serena");
        expect(gemini.theme).toBe("dark"); // unrelated state preserved

        // codex: [mcp_servers.serena] incl. nested .env/.http_headers gone;
        // [projects.*] and [notice] untouched
        const codex = TOML.parse(readFileSync(join(homeDir, ".codex", "config.toml"), "utf-8")) as {
            notice?: { seen?: boolean };
            projects?: Record<string, { trust_level?: string }>;
            mcp_servers?: Record<string, unknown>;
        };
        expect(codex.mcp_servers?.serena).toBeUndefined();
        expect(codex.mcp_servers?.github).toBeDefined();
        expect(codex.notice?.seen).toBe(true);
        expect(codex.projects?.["/Users/x/proj"]?.trust_level).toBe("trusted");

        // unified config: mcpServers block + enabledMcpServers mirror gone,
        // user comments preserved through the write
        const storage = new Storage("mcp-manager");
        const rawUnified = readFileSync(storage.getConfigPath(), "utf-8");
        expect(rawUnified).toContain("keep-me: precious user comment about github");
        expect(rawUnified).not.toContain('"serena"');
        const unified = SafeJSON.parse(rawUnified) as {
            mcpServers: Record<string, unknown>;
            enabledMcpServers?: Record<string, unknown>;
        };
        expect(unified.mcpServers.serena).toBeUndefined();
        expect(unified.mcpServers.github).toBeDefined();
        expect(unified.enabledMcpServers?.serena).toBeUndefined();
        expect(unified.enabledMcpServers?.github).toBeDefined();
    });

    it("prints the reversible-alternative hint", async () => {
        writeFixtures();
        const providers = [new ClaudeProvider()];

        await removeServers("serena", providers, {});

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("disable"));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("PERMANENTLY"));
    });

    it("rejects unknown server names without touching any config", async () => {
        writeFixtures();
        const providers = [new ClaudeProvider()];
        const before = readFileSync(join(homeDir, ".claude.json"), "utf-8");

        await removeServers("does-not-exist", providers, {});

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not found"));
        expect(readFileSync(join(homeDir, ".claude.json"), "utf-8")).toBe(before);
    });

    it("skips providers whose config does not exist", async () => {
        writeFixtures();
        rmSync(join(homeDir, ".cursor"), { recursive: true, force: true });
        const providers = [new ClaudeProvider(), new CursorProvider()];

        await removeServers("serena", providers, {});

        const claude = readJson(join(homeDir, ".claude.json")) as { mcpServers: Record<string, unknown> };
        expect(claude.mcpServers.serena).toBeUndefined();
        expect(logger.error).not.toHaveBeenCalled();
    });
});
