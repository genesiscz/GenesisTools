import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getDevDashboardStorage, resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { resolveVaultRoot } from "@genesiscz/utils/obsidian/config";
import { getConfig, getOrCreateDashboardAuth, resolveDashboardVault, saveConfig, saveTtydSessions } from "./config";

describe("dev-dashboard config", () => {
    it("defaults allowedHosts to an empty array", async () => {
        const config = await getConfig();
        expect(Array.isArray(config.allowedHosts)).toBe(true);
    });
});

describe("dev-dashboard obsidian vault", () => {
    it("resolves via the shared src/utils/obsidian resolver, not a hardcoded schema default", () => {
        // The intent of dropping the hardcoded default: the value now comes
        // from the shared resolver. (It may legitimately equal the user's real
        // vault path — that's discovery working, not a hardcoded constant.)
        expect(resolveDashboardVault()).toBe(resolveVaultRoot());
    });

    it("an explicit per-dashboard override wins over discovery", () => {
        expect(resolveDashboardVault("/explicit/override")).toBe("/explicit/override");
    });
});

/**
 * getConfig serves defaults for a file the schema rejects, and every caller used to save those defaults
 * back with its one change, which wiped the auth hash and the published notes. No save may do that.
 */
describe("dev-dashboard config that exists but cannot be used", () => {
    const AUTH = {
        enabled: true,
        username: "alice",
        passwordSalt: "c2FsdC1maXh0dXJl",
        passwordHash: "aGFzaC1maXh0dXJl",
    };
    const NOTES = [{ slug: "kept-note", vaultPath: "Notes/kept.md", publishedAt: "2026-10-01T10:00:00.000Z" }];
    const SCHEMA_FAILURE = SafeJSON.stringify({ port: "not-a-port", auth: AUTH, publishedNotes: NOTES }, null, 2);

    let prevHome: string | undefined;
    let configPath: string;

    beforeEach(() => {
        prevHome = env.get("GENESIS_TOOLS_HOME");
        env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "dd-config-")));
        resetDevDashboardStorage();
        configPath = getDevDashboardStorage().getConfigPath();
        mkdirSync(dirname(configPath), { recursive: true });
    });

    afterEach(() => {
        if (prevHome === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", prevHome);
        }

        resetDevDashboardStorage();
    });

    it("serves defaults for a schema failure, but refuses to save them over the file", async () => {
        writeFileSync(configPath, SCHEMA_FAILURE);

        expect((await getConfig()).publishedNotes).toEqual([]);
        await expect(saveTtydSessions([])).rejects.toThrow(configPath);
        await expect(getOrCreateDashboardAuth()).rejects.toThrow(/fails schema validation, so it was left untouched/);
        expect(readFileSync(configPath, "utf8")).toBe(SCHEMA_FAILURE);
    });

    it("refuses to save over a file that does not parse", async () => {
        const defaults = await getConfig();
        const truncated = SCHEMA_FAILURE.slice(0, 80);
        writeFileSync(configPath, truncated);

        await expect(saveConfig(defaults)).rejects.toThrow(/does not parse, so it was left untouched/);
        expect(readFileSync(configPath, "utf8")).toBe(truncated);
    });

    it("a valid file still saves one change, keeps the rest, and stays 0600", async () => {
        writeFileSync(configPath, SafeJSON.stringify({ auth: AUTH, publishedNotes: NOTES }, null, 2));

        await saveTtydSessions([
            { id: "ttyd-1", port: 7681, command: "zsh", cwd: "/tmp", pid: 4242, startedAt: "2026-10-01T10:00:00.000Z" },
        ]);

        const saved = SafeJSON.parse(readFileSync(configPath, "utf8"), { strict: true });
        expect(saved.auth.passwordHash).toBe(AUTH.passwordHash);
        expect(saved.publishedNotes).toEqual(NOTES);
        expect(saved.ttydSessions).toHaveLength(1);

        if (process.platform !== "win32") {
            expect(statSync(configPath).mode & 0o777).toBe(0o600);
        }
    });
});
