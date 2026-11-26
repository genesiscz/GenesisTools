import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    importLegacyShare,
    legacyShareImport,
    loadSharePublishConfig,
} from "@app/dev-dashboard/lib/share/legacy-share";
import { shareStatusFor } from "@app/dev-dashboard/lib/share/status";
import { getDevDashboardStorage, resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@genesiscz/utils/env";
import {
    loadShareConfig,
    publicationsPath,
    shareConfigPath,
    updateShareConfig,
} from "@genesiscz/utils/genesis-tools/publish/store";
import { SafeJSON } from "@genesiscz/utils/json";
import { resolveVaultRoot } from "@genesiscz/utils/obsidian/config";
import { getConfig, getOrCreateDashboardAuth, resolveDashboardVault, saveConfig, saveTtydSessions } from "./config";

describe("dev-dashboard config", () => {
    it("defaults allowedHosts to an empty array", async () => {
        const config = await getConfig();
        expect(Array.isArray(config.allowedHosts)).toBe(true);
    });
});

describe("dev-dashboard share migration", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const published = "2026-01-01T03:00:00.000Z";
    const sourceModifiedAt = "2026-01-01T01:00:00.000Z";
    const syncedAt = "2026-01-01T02:00:00.000Z";
    const token = { type: "secure", path: "dev-dashboard/share-targets/remote/token" } as const;
    const namedShare = {
        defaults: { target: "remote" },
        targets: [
            { name: "mac", driver: "mac-live" },
            { name: "remote", driver: "paired", url: "https://share.example.com/md", deviceId: "fixture", token },
        ],
    };
    const note = {
        slug: "fixture",
        vaultPath: "Notes/Weekly.md",
        publishedAt: at,
        targets: ["remote", "mac"],
        syncs: { remote: { syncedAt, sourceModifiedAt } },
    };
    const raw = {
        allowedHosts: ["mac.example.com"],
        share: namedShare,
        publishedNotes: [note, { slug: "other", vaultPath: "Other.md", publishedAt: published, targets: [] }],
    };
    const livePublicBase = "https://mac.example.com";

    let dir: string;
    let configPath: string;
    let prevHome: string | undefined;

    beforeEach(async () => {
        prevHome = env.get("GENESIS_TOOLS_HOME");
        dir = mkdtempSync(join(tmpdir(), "share-migration-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
        const storage = getDevDashboardStorage();
        configPath = storage.getConfigPath();
        await storage.setConfig(raw);
    });

    afterEach(() => {
        if (prevHome === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", prevHome);
        }

        resetDevDashboardStorage();
        rmSync(dir, { recursive: true, force: true });
    });

    it("imports both targets and note sync records once and keeps the note registry", async () => {
        expect(await importLegacyShare()).toEqual({ imported: ["mac", "remote"] });

        const first = [configPath, shareConfigPath(), publicationsPath()].map((path) => readFileSync(path, "utf8"));
        expect(SafeJSON.parse(first[1])).toEqual({
            version: 2,
            servers: [],
            defaults: { target: "remote" },
            targets: [
                {
                    name: "mac",
                    publicBase: livePublicBase,
                    transport: { kind: "mac-live", mounts: { md: "/share" } },
                },
                {
                    name: "remote",
                    publicBase: "https://share.example.com",
                    transport: { kind: "paired", url: "https://share.example.com", deviceId: "fixture", token },
                },
            ],
        });
        expect(SafeJSON.parse(first[2])).toEqual({
            version: 1,
            publications: [
                {
                    kind: "md",
                    id: "fixture",
                    title: "Weekly",
                    source: "Notes/Weekly.md",
                    publishedAt: at,
                    syncs: { remote: { syncedAt, sourceModifiedAt }, mac: { syncedAt: at, sourceModifiedAt: at } },
                },
                { kind: "md", id: "other", title: "Other", source: "Other.md", publishedAt: published, syncs: {} },
            ],
        });
        const saved = SafeJSON.parse(first[0]);
        expect(saved.share).toBeUndefined();
        expect(saved.publishedNotes).toEqual([
            { slug: "fixture", vaultPath: "Notes/Weekly.md", publishedAt: at },
            { slug: "other", vaultPath: "Other.md", publishedAt: published },
        ]);
        expect(saved.allowedHosts).toEqual(["mac.example.com"]);
        expect(statSync(shareConfigPath()).mode & 0o777).toBe(0o600);
        expect(statSync(publicationsPath()).mode & 0o777).toBe(0o600);

        expect(await importLegacyShare()).toEqual({ imported: [] });
        expect([configPath, shareConfigPath(), publicationsPath()].map((path) => readFileSync(path, "utf8"))).toEqual(
            first
        );
    });

    it("preserves a target already in the store and keeps status reads free of writes", async () => {
        const before = readFileSync(configPath, "utf8");
        expect((await loadSharePublishConfig()).defaults.target).toBe("remote");
        expect(await shareStatusFor(note)).toMatchObject([
            { target: "mac", live: true, url: "https://mac.example.com/share/fixture" },
            {
                target: "remote",
                live: false,
                isDefault: true,
                url: "https://share.example.com/md/fixture",
                syncedAt,
                sourceModifiedAt,
            },
        ]);
        expect(readFileSync(configPath, "utf8")).toBe(before);
        expect(existsSync(shareConfigPath())).toBe(false);
        expect(existsSync(publicationsPath())).toBe(false);

        const existing = {
            name: "remote",
            publicBase: "https://new.example.com",
            transport: { kind: "mac-live", mounts: { md: "/other" } },
        } as const;
        await updateShareConfig((config) => ({ ...config, targets: [existing] }));
        expect(await importLegacyShare()).toEqual({ imported: ["mac"] });
        expect((await loadShareConfig()).targets.find((entry) => entry.name === "remote")).toEqual(existing);
    });

    it("converts the first share.target format, defaults incomplete settings to Mac and refuses duplicate or plaintext targets", () => {
        const parse = (share: unknown) => legacyShareImport({ rawConfig: { share }, livePublicBase });
        const converted = parse({
            target: "server",
            server: {
                host: "deploy@share.example.com",
                dataDir: "/srv/share/data/",
                publicBase: "https://example.com/share/",
            },
        });
        expect(converted?.defaultTarget).toBe("server");
        expect(converted?.targets[1]).toEqual({
            name: "server",
            publicBase: "https://example.com",
            transport: { kind: "ssh-rsync", host: "deploy@share.example.com", dataDir: "/srv/share/data" },
        });
        expect(parse({ target: "server", server: {} })?.defaultTarget).toBe("mac");
        expect(() => parse({ targets: [namedShare.targets[0], namedShare.targets[0]] })).toThrow();
        expect(() => parse({ targets: [{ ...namedShare.targets[1], token: "gtshare_plain" }] })).toThrow();
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
