import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setGlobalOptions } from "@app/mcp-manager/utils/config.utils.js";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { ClaudeProvider } from "./claude.ts";
import { CodexProvider } from "./codex.ts";
import { CursorProvider } from "./cursor.ts";
import { GeminiProvider } from "./gemini.ts";
import { GrokProvider } from "./grok.ts";
import { type MCPProvider, WriteResult } from "./types.ts";

/**
 * Every verb of the ten-member interface against each adapter, on a fixture file in the harness's own
 * format (JSON for Claude, Cursor and Gemini, TOML for Codex and Grok). Every write goes through the
 * base write cycle, so the rejected and the nothing-to-do cases are checked once per adapter here.
 */

interface Harness {
    name: string;
    /** File under the fixture home, and its text. `alpha` is installed and enabled in each. */
    file: string;
    fixture: string;
    make: () => MCPProvider;
    /** Presence means enabled: no disabled state, so disable removes the entry and enable needs it present. */
    presence: boolean;
}

const HARNESSES: Harness[] = [
    {
        name: "claude",
        file: ".claude.json",
        fixture: SafeJSON.stringify(
            {
                numStartups: 1,
                mcpServers: { alpha: { type: "stdio", command: "alpha-cmd", args: ["--x"] } },
                projects: { "/work/app": { allowedTools: [] } },
            },
            null,
            2
        ),
        make: () => new ClaudeProvider(),
        presence: false,
    },
    {
        name: "cursor",
        file: ".cursor/mcp.json",
        fixture: SafeJSON.stringify(
            { mcpServers: { alpha: { type: "stdio", command: "alpha-cmd", args: ["--x"] } } },
            null,
            4
        ),
        make: () => new CursorProvider(),
        presence: true,
    },
    {
        name: "gemini",
        file: ".gemini/settings.json",
        fixture: SafeJSON.stringify(
            { theme: "GitHub", mcpServers: { alpha: { command: "alpha-cmd", args: ["--x"] } } },
            null,
            2
        ),
        make: () => new GeminiProvider(),
        presence: false,
    },
    {
        name: "codex",
        file: ".codex/config.toml",
        fixture: `model = "gpt-x"\n\n[mcp_servers.alpha]\ncommand = "alpha-cmd"\nargs = ["--x"]\n`,
        make: () => new CodexProvider(),
        presence: true,
    },
    {
        name: "grok",
        file: ".grok/config.toml",
        fixture: `[mcp_servers.alpha]\ncommand = "alpha-cmd"\nargs = ["--x"]\nenabled = true\n\n[ui]\ntheme = "dark"\n`,
        make: () => new GrokProvider(),
        presence: false,
    },
];

/** The protected field a test reaches to answer the confirmation prompt with "no". */
interface ProviderInternals {
    backupManager: { askConfirmation: () => Promise<boolean> };
}

describe.each(HARNESSES)("$name adapter verbs", (harness) => {
    let home: string;
    let previousHome: string | undefined;
    let previousClaudeConfigDir: string | undefined;
    let configPath: string;

    beforeEach(() => {
        previousHome = env.get("HOME");
        previousClaudeConfigDir = env.get("CLAUDE_CONFIG_DIR");
        env.testing.unset("CLAUDE_CONFIG_DIR");
        home = mkdtempSync(join(tmpdir(), `mcp-verbs-${harness.name}-`));
        env.testing.set("HOME", home);
        configPath = join(home, harness.file);
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, harness.fixture);
        setGlobalOptions({ yes: true });
    });

    afterEach(() => {
        setGlobalOptions({});

        if (previousHome !== undefined) {
            env.testing.set("HOME", previousHome);
        } else {
            env.testing.unset("HOME");
        }

        if (previousClaudeConfigDir !== undefined) {
            env.testing.set("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
        } else {
            env.testing.unset("CLAUDE_CONFIG_DIR");
        }

        rmSync(home, { recursive: true, force: true });
    });

    const text = () => readFileSync(configPath, "utf-8");
    const enabledNames = async (provider: MCPProvider) =>
        (await provider.listServers()).filter((server) => server.enabled).map((server) => server.name);

    test("reads: configExists, readConfig, listServers, getServerConfig, toUnifiedConfig", async () => {
        const provider = harness.make();

        expect(provider.getConfigPath()).toBe(configPath);
        expect(await provider.configExists()).toBe(true);
        expect(await enabledNames(provider)).toEqual(["alpha"]);
        expect((await provider.getServerConfig("alpha"))?.command).toBe("alpha-cmd");
        expect(await provider.getServerConfig("nope")).toBeNull();
        expect(provider.toUnifiedConfig(await provider.readConfig()).alpha?.args).toEqual(["--x"]);
    });

    test("installServer adds the entry and keeps the rest of the file", async () => {
        const provider = harness.make();

        expect(await provider.installServer("fresh", { type: "stdio", command: "fresh-cmd", args: ["a"] })).toBe(
            WriteResult.Applied
        );
        expect((await provider.getServerConfig("fresh"))?.command).toBe("fresh-cmd");
        expect((await provider.getServerConfig("alpha"))?.command).toBe("alpha-cmd");
    });

    test("disableServers turns the server off; enableServers turns it back on where the harness can", async () => {
        const provider = harness.make();

        expect(await provider.disableServers(["alpha"])).toBe(WriteResult.Applied);
        expect(await enabledNames(provider)).not.toContain("alpha");

        if (harness.presence) {
            expect(await provider.getServerConfig("alpha")).toBeNull();
            await expect(provider.enableServers(["alpha"])).rejects.toThrow("Servers do not exist: alpha");
            return;
        }

        expect(await provider.enableServers(["alpha"])).toBe(WriteResult.Applied);
        expect(await enabledNames(provider)).toContain("alpha");
    });

    test("enableServers on an enabled server writes nothing in a presence harness", async () => {
        const provider = harness.make();
        const before = text();
        const result = await provider.enableServers(["alpha"]);

        if (harness.presence) {
            expect(result).toBe(WriteResult.NoChanges);
            expect(text()).toBe(before);
        }

        expect(await enabledNames(provider)).toContain("alpha");
    });

    test("removeServers deletes the entry; a name that is not there leaves the file byte for byte", async () => {
        const provider = harness.make();
        const before = text();

        expect(await provider.removeServers(["nope"])).toBe(WriteResult.NoChanges);
        expect(text()).toBe(before);

        expect(await provider.removeServers(["alpha"])).toBe(WriteResult.Applied);
        expect(await provider.getServerConfig("alpha")).toBeNull();
    });

    test("syncServers writes an enabled server and switches a disabled one off", async () => {
        const provider = harness.make();
        const all = { claude: true, cursor: true, gemini: true, codex: true, grok: true };
        const none = { claude: false, cursor: false, gemini: false, codex: false, grok: false };

        expect(
            await provider.syncServers({
                synced: { type: "stdio", command: "synced-cmd", _meta: { enabled: all } },
                alpha: { type: "stdio", command: "alpha-cmd", args: ["--x"], _meta: { enabled: none } },
            })
        ).toBe(WriteResult.Applied);
        expect((await provider.getServerConfig("synced"))?.command).toBe("synced-cmd");
        expect(await enabledNames(provider)).not.toContain("alpha");
    });

    test("a rejected confirmation leaves the file as it was", async () => {
        setGlobalOptions({});
        const provider = harness.make();
        (provider as unknown as ProviderInternals).backupManager.askConfirmation = async () => false;
        const before = text();

        expect(await provider.installServer("fresh", { type: "stdio", command: "fresh-cmd" })).toBe(
            WriteResult.Rejected
        );
        expect(text()).toBe(before);
    });
});
