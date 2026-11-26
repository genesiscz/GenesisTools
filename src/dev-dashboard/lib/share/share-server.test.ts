import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectShareServerStatus, startShareServe } from "@app/dev-dashboard/commands/share-server";
import { configureShareServer, parseLegacyShareUnit } from "@app/dev-dashboard/commands/share-server-setup";
import { runTargetAdd } from "@app/dev-dashboard/commands/share-target";
import { mdKind } from "@app/dev-dashboard/lib/share/kind";
import { PUBLISH_KIND_SERVERS } from "@app/dev-dashboard/lib/share/server/kinds";
import { shareStatusFor } from "@app/dev-dashboard/lib/share/status";
import { shareToTargets } from "@app/dev-dashboard/lib/share/targets";
import { getDevDashboardStorage, resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@genesiscz/utils/env";
import { type ZipEntry, zip } from "@genesiscz/utils/fs/zip";
import {
    findPublication,
    loadShareConfig,
    type ShareServerConfig,
    shareConfigPath,
    shareServerDir,
    updateShareConfig,
} from "@genesiscz/utils/genesis-tools/publish/store";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { HealthSchema, PUBLISH_API } from "@genesiscz/utils/publish/api";
import { clientAuditDir, readAudit } from "@genesiscz/utils/publish/audit";
import { startPublishServer } from "@genesiscz/utils/publish/server";
import { createSystemdInstaller } from "@genesiscz/utils/publish/service/systemd";
import { installSnapshot } from "@genesiscz/utils/publish/snapshot-store";
import { transportFor } from "@genesiscz/utils/publish/transports";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    resolveSecret,
    secrets,
} from "@genesiscz/utils/security";
import { formatAgo, freshnessTone, isEditedAfterSync } from "./freshness";
import { SHARE_SNAPSHOT_VERSION, type ShareSnapshotManifest } from "./snapshot";

const SLUG = "AbCdEf0123456789";
const PICTURE = Buffer.from("\u0089PNG fixture picture");
const PICTURE_HASH = createHash("sha256").update(PICTURE).digest("hex");

function manifest(overrides: Partial<ShareSnapshotManifest> = {}): ShareSnapshotManifest {
    const asset = {
        hash: PICTURE_HASH,
        absPath: "/vault/Notes/pic.png",
        vaultPath: "Notes/pic.png",
        name: "pic.png",
        kind: "image" as const,
        contentType: "image/png",
        file: `assets/${PICTURE_HASH}.png`,
    };

    return {
        version: SHARE_SNAPSHOT_VERSION,
        slug: SLUG,
        title: "Fixture Note",
        vaultPath: "Notes/Fixture Note.md",
        publishedAt: "2026-01-01T00:00:00.000Z",
        snapshotAt: "2026-01-01T00:00:00.000Z",
        noteFile: "note.md",
        links: [],
        assets: {
            sharedNote: "/vault/Notes/Fixture Note.md",
            list: [asset],
            byTarget: { "pic.png": 0 },
            byHash: { [PICTURE_HASH]: 0 },
            linkedImages: {},
        },
        ...overrides,
    };
}

function snapshotZip(
    options: { manifest?: ShareSnapshotManifest; extra?: ZipEntry[]; skip?: string } = {}
): Uint8Array {
    const entries: ZipEntry[] = [
        { name: "manifest.json", data: new TextEncoder().encode(SafeJSON.stringify(options.manifest ?? manifest())) },
        { name: "note.md", data: new TextEncoder().encode("# Fixture Note\n\n![[pic.png]]\n") },
        { name: `assets/${PICTURE_HASH}.png`, data: PICTURE },
        ...(options.extra ?? []),
    ];

    return zip(entries.filter((entry) => entry.name !== options.skip));
}

describe("share freshness", () => {
    const at = (iso: string) => Date.parse(iso);

    test("the colour follows the age: green under an hour, blue under a day, amber under a week, grey after", () => {
        expect(freshnessTone(59 * 60_000)).toBe("fresh");
        expect(freshnessTone(2 * 3_600_000)).toBe("recent");
        expect(freshnessTone(3 * 86_400_000)).toBe("aging");
        expect(freshnessTone(8 * 86_400_000)).toBe("stale");
        expect(formatAgo(5_000)).toBe("just now");
        expect(formatAgo(30_000)).toBe("30 s ago");
        expect(formatAgo(5 * 60_000)).toBe("5 min ago");
        expect(formatAgo(86_400_000)).toBe("1 day ago");
        expect(formatAgo(21 * 86_400_000)).toBe("3 weeks ago");
        expect(at("2026-01-01T00:00:00Z")).toBeGreaterThan(0);
    });

    test("a note is stale on a target only when it was edited after the version that target holds", () => {
        const sync = { syncedAt: "2026-01-02T10:00:00Z", sourceModifiedAt: "2026-01-02T09:00:00Z" };

        expect(isEditedAfterSync("2026-01-02T09:00:00.400Z", sync)).toBe(false);
        expect(isEditedAfterSync("2026-01-02T09:30:00Z", sync)).toBe(true);
        expect(isEditedAfterSync(undefined, sync)).toBe(false);
        expect(isEditedAfterSync("2026-01-02T09:30:00Z", undefined)).toBe(false);
    });
});

describe("published note snapshots", () => {
    let dir: string;
    let prevHome: string | undefined;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "published-note-"));
        prevHome = env.get("GENESIS_TOOLS_HOME");
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
    });

    afterEach(() => {
        if (prevHome === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", prevHome);
        }

        resetDevDashboardStorage();
        _resetSecretsForTest();
        _resetMasterKeyProviders();
        rmSync(dir, { recursive: true, force: true });
    });

    test.each([
        ["a file a note snapshot never holds", { extra: [{ name: "extra.txt", data: new Uint8Array([1]) }] }],
        ["a manifest for another slug", { manifest: manifest({ slug: "OtherSlug0123456" }) }],
        ["a listed asset missing from the zip", { skip: `assets/${PICTURE_HASH}.png` }],
        ["no manifest", { skip: "manifest.json" }],
    ])("refuses a note upload with %s", async (_label, options) => {
        const result = await installSnapshot({
            dataDir: join(dir, "data"),
            kind: mdKind,
            id: SLUG,
            body: snapshotZip(options),
            minFreeBytes: 0,
        });
        expect(result).toMatchObject({ ok: false, status: 400 });
    });

    test("serves the uploaded note and picture beneath /md", async () => {
        const dataDir = join(dir, "data");
        const server = await startPublishServer({
            kinds: Object.values(PUBLISH_KIND_SERVERS),
            dataDir,
            stateDir: join(dir, "state"),
            publicBase: "https://share.example.com/md",
            port: 0,
            host: "127.0.0.1",
            minFreeBytes: 0,
        });
        try {
            const { code } = server.context.devices.createPairingCode();
            const device = await server.context.devices.pair(code, "desk");
            if (!device) {
                throw new Error("fixture pairing failed");
            }

            const upload = await fetch(new URL(PUBLISH_API.snapshot("md", SLUG), server.url), {
                method: "PUT",
                headers: { Authorization: `Bearer ${device.token}` },
                body: new Uint8Array(snapshotZip()),
            });
            expect(upload.status).toBe(200);
            const page = await fetch(`${server.url}/md/${SLUG}`, { headers: { accept: "text/html" } });
            expect(page.status).toBe(200);
            const html = await page.text();
            expect(html).toContain("Fixture Note");
            expect(html).toContain(`/md/${SLUG}?asset=${PICTURE_HASH}`);
            const image = await fetch(`${server.url}/md/${SLUG}?asset=${PICTURE_HASH}`);
            expect(Buffer.from(await image.arrayBuffer()).equals(PICTURE)).toBe(true);
        } finally {
            await server.stop();
        }
    });

    function useFixtureVaultKey(): void {
        const key = randomBytes(32);
        _setMasterKeyProvidersForTest([
            {
                id: "keychain",
                available: async () => true,
                get: async () => key,
                getSync: () => key,
                set: async () => {},
            },
        ]);
        _resetSecretsForTest();
    }

    test("the reader gets the paired default link and the times saved by the publisher", async () => {
        useFixtureVaultKey();
        const vault = join(dir, "vault");
        mkdirSync(vault);
        writeFileSync(join(vault, "Note.md"), "# Weekly report\n");
        await getDevDashboardStorage().setConfig({ obsidianVault: vault });

        const server = await startPublishServer({
            kinds: Object.values(PUBLISH_KIND_SERVERS),
            dataDir: join(dir, "data"),
            stateDir: join(dir, "state"),
            publicBase: "https://share.example.com",
            port: 0,
            host: "127.0.0.1",
            minFreeBytes: 0,
        });
        try {
            const { code } = server.context.devices.createPairingCode();
            const device = await server.context.devices.pair(code, "desk");
            if (!device) {
                throw new Error("fixture pairing failed");
            }

            const token = await (await secrets()).set("publish/targets/remote/token", device.token);
            await updateShareConfig((config) => ({
                ...config,
                defaults: { target: "remote" },
                targets: [
                    {
                        name: "remote",
                        publicBase: "https://share.example.com",
                        transport: { kind: "paired", url: server.url, deviceId: device.deviceId, token },
                    },
                ],
            }));
            const { note, outcomes } = await shareToTargets({ vaultPath: "Note.md", targetNames: [] });
            const url = `https://share.example.com/md/${note.slug}`;
            expect(outcomes).toEqual([{ target: "remote", url }]);
            const publication = await findPublication({ kind: "md", id: note.slug });
            const sync = publication?.syncs.remote;
            expect(sync).toEqual({ syncedAt: expect.any(String), sourceModifiedAt: expect.any(String) });
            expect(await shareStatusFor(note)).toEqual([
                {
                    target: "remote",
                    driver: "paired",
                    live: false,
                    isDefault: true,
                    url,
                    syncedAt: sync?.syncedAt ?? null,
                    sourceModifiedAt: sync?.sourceModifiedAt ?? null,
                },
            ]);
        } finally {
            await server.stop();
        }
    });

    async function configureServer(): Promise<ShareServerConfig> {
        const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
        const port = Number(probe.port);
        await probe.stop(true);
        const config: ShareServerConfig = {
            name: "desk",
            listen: { host: "127.0.0.1", port },
            publicOrigin: "https://share.example.com",
            dataDir: shareServerDir("desk", "data"),
            stateDir: shareServerDir("desk", "state"),
            kinds: ["md", "artifact"],
            minFreeGb: 0,
            exposure: { kind: "local" },
            service: { manager: "none" },
        };
        await updateShareConfig((current) => ({
            ...current,
            defaults: { ...current.defaults, server: "desk" },
            servers: [config],
        }));
        return config;
    }

    test("serve reads the configured listener without flags", async () => {
        const config = await configureServer();
        const { server } = await startShareServe();
        try {
            expect(Number(new URL(server.url).port)).toBe(config.listen.port);
            expect(server.context.dataDir).toBe(config.dataDir);
            const res = await fetch(new URL(PUBLISH_API.health, server.url));
            expect(HealthSchema.parse(await res.json()).kinds).toEqual(["md", "artifact"]);
        } finally {
            await server.stop();
        }
    });

    test("serve overrides a saved path and still accepts the old flag-only unit", async () => {
        const config = await configureServer();
        const data = join(dir, "override");
        const first = await startShareServe({
            server: config.name,
            data,
            publicBase: "https://override.example.com/md",
        });
        try {
            expect(first.server.context.dataDir).toBe(data);
            expect(first.server.context.origin).toBe("https://override.example.com");
            expect(first.stateDir).toBe(config.stateDir);
        } finally {
            await first.server.stop();
        }

        await updateShareConfig((current) => ({ ...current, defaults: {}, servers: [] }));
        const legacy = await startShareServe({
            data,
            state: join(dir, "legacy"),
            port: 0,
            host: "127.0.0.1",
            publicBase: "https://share.example.com/md",
        });
        try {
            const res = await fetch(new URL(PUBLISH_API.health, legacy.server.url));
            expect(HealthSchema.parse(await res.json()).kinds).toEqual(["md", "artifact"]);
        } finally {
            await legacy.server.stop();
        }
    });

    function scratchSystemd(failure?: { restart: boolean }) {
        const unitDir = join(dir, "units");
        const calls: string[][] = [];
        const run = async (argv: string[]) => {
            calls.push(argv);
            const [from, to] = argv.slice(-2);
            if (argv[0] === "install") {
                await mkdir(dirname(to), { recursive: true });
                await copyFile(from, to);
            }

            if (failure?.restart && argv[0] === "systemctl" && argv[1] === "restart") {
                failure.restart = false;
                throw new Error("fixture restart failed");
            }
        };
        const installer = createSystemdInstaller({ unitDir, root: true, run });
        const deps = {
            interactive: false,
            platform: "linux" as const,
            account: { name: "desk", uid: 1000, gid: 1000, home: dir },
            installer: () => installer,
            runSystemCommand: run,
        };
        return { unitDir, calls, deps };
    }

    test("non-interactive setup saves named config and installs into a scratch unit directory", async () => {
        const { unitDir, calls, deps } = scratchSystemd();
        const dataDir = join(dir, "snapshots");
        const stateDir = join(dir, "state");
        const configured = await configureShareServer(
            {
                server: "desk",
                yes: true,
                publicOrigin: "https://share.example.com",
                host: "127.0.0.1",
                port: 3944,
                dataDir,
                stateDir,
                exposure: "reverse-proxy",
                proxy: "apache",
                service: "systemd",
                serviceUser: "desk",
                root: join(dir, "project"),
                bun: "/usr/bin/bun",
            },
            deps
        );
        expect(await loadShareConfig()).toEqual({
            version: 2,
            defaults: { server: "desk" },
            servers: [configured.server],
            targets: [],
        });
        expect(configured.server).toMatchObject({
            dataDir,
            stateDir,
            listen: { host: "127.0.0.1", port: 3944 },
            publicOrigin: "https://share.example.com",
        });
        const unit = readFileSync(join(unitDir, "genesis-share-desk.service"), "utf8");
        expect(unit).toContain("share-server serve --server desk");
        expect(unit).toContain("User=desk");
        expect(calls.slice(-2)).toEqual([
            ["systemctl", "enable", "genesis-share-desk.service"],
            ["systemctl", "restart", "genesis-share-desk.service"],
        ]);
    });

    test("rolls back a failed adoption and retries with the original snapshots and devices", async () => {
        const { unitDir, calls, deps } = scratchSystemd({ restart: true });
        const oldData = join(dir, "original data");
        const oldState = join(dir, "original-state");
        const original = join(unitDir, "genesis-share-server.service");
        mkdirSync(unitDir);
        mkdirSync(oldData);
        mkdirSync(oldState);
        writeFileSync(join(oldData, "snapshot-marker"), "kept");
        writeFileSync(join(oldState, "devices.json"), '{"version":1,"devices":[]}');
        const text = `[Service]\nUser=desk\nExecStart=/usr/bin/bun /srv/project/src/dev-dashboard/index.ts share-server serve --data "${oldData}" --state ${oldState} --port 3944 --host 127.0.0.1 --public-base https://share.example.com/md\n`;
        writeFileSync(original, text);
        const parsed = parseLegacyShareUnit({ text, name: "desk", path: original });
        expect(parsed).toMatchObject({
            dataDir: oldData,
            stateDir: oldState,
            publicOrigin: "https://share.example.com",
            listen: { host: "127.0.0.1", port: 3944 },
        });
        const opts = { server: "desk", yes: true, adoptUnit: original } as const;
        const before = await loadShareConfig();
        await expect(configureShareServer(opts, deps)).rejects.toThrow("fixture restart failed");
        expect(await loadShareConfig()).toEqual(before);
        expect(readFileSync(original, "utf8")).toBe(text);
        expect(readFileSync(join(oldData, "snapshot-marker"), "utf8")).toBe("kept");
        expect(readFileSync(join(oldState, "devices.json"), "utf8")).toBe('{"version":1,"devices":[]}');
        expect(existsSync(shareServerDir("desk", "data"))).toBe(false);
        expect(existsSync(shareServerDir("desk", "state"))).toBe(false);
        expect(calls.at(-1)).toEqual(["systemctl", "restart", "genesis-share-server.service"]);
        const { server } = await configureShareServer(opts, deps);
        expect(server.dataDir).toBe(shareServerDir("desk", "data"));
        expect(server.stateDir).toBe(shareServerDir("desk", "state"));
        expect(readFileSync(join(server.dataDir, "snapshot-marker"), "utf8")).toBe("kept");
        expect(readFileSync(join(server.stateDir, "devices.json"), "utf8")).toBe('{"version":1,"devices":[]}');
        expect(existsSync(oldData)).toBe(false);
        expect(existsSync(oldState)).toBe(false);
        expect(calls[0]).toEqual(["systemctl", "disable", "--now", "genesis-share-server.service"]);
        expect(readFileSync(join(unitDir, "genesis-share-server.service"), "utf8")).toContain(
            "share-server serve --server desk"
        );
    });

    test("status probes the listener, kinds, admin socket and disk without writing client config", async () => {
        const dataDir = join(dir, "data");
        const stateDir = join(dir, "state");
        const server = await startPublishServer({
            kinds: Object.values(PUBLISH_KIND_SERVERS),
            dataDir,
            stateDir,
            host: "127.0.0.1",
            port: 0,
            publicBase: "https://share.example.com",
        });
        try {
            const opts = {
                data: dataDir,
                state: stateDir,
                port: Number(new URL(server.url).port),
                publicBase: server.url,
                minFreeGb: 0,
            };
            const rows = await collectShareServerStatus(opts);
            expect(rows.map(({ label, ok }) => [label, ok])).toEqual([
                ["Local port", true],
                ["Local health", true],
                ["Public health", true],
                ["Admin socket", true],
                ["Paired devices", true],
                ["md snapshots", true],
                ["artifact snapshots", true],
                ["Free disk", true],
                ["Live mounts", true],
            ]);
            expect(rows.find(({ label }) => label === "Local health")?.detail).toBe("md, artifact");
            expect(rows.find(({ label }) => label === "Paired devices")?.detail).toBe("0");
            const failed = await collectShareServerStatus({ ...opts, minFreeGb: 1_000_000 });
            expect(failed.find(({ label }) => label === "Free disk")?.ok).toBe(false);
            expect(existsSync(shareConfigPath())).toBe(false);
            expect(existsSync(getDevDashboardStorage().getConfigPath())).toBe(false);
        } finally {
            await server.stop();
        }
    });

    test("client setup re-pairs the same target and prints the old device for revocation", async () => {
        useFixtureVaultKey();
        const server = await startPublishServer({
            kinds: Object.values(PUBLISH_KIND_SERVERS),
            dataDir: join(dir, "data"),
            stateDir: join(dir, "state"),
            publicBase: "https://share.example.com",
            port: 0,
            host: "127.0.0.1",
            minFreeBytes: 0,
        });
        const exitCode = process.exitCode;
        const printed = spyOn(out, "println");
        try {
            await runTargetAdd("remote", {
                driver: "paired",
                url: server.url,
                code: server.context.devices.createPairingCode().code,
                publicBase: "https://share.example.com",
                deviceName: "desk",
                default: true,
            });
            const previous = (await loadShareConfig()).targets.find(({ name }) => name === "remote");
            if (previous?.transport.kind !== "paired") {
                throw new Error("fixture has no paired target");
            }

            const previousToken = await resolveSecret(previous.transport.token);
            await runTargetAdd("remote", {
                driver: "paired",
                replace: true,
                code: server.context.devices.createPairingCode().code,
                deviceName: "desk",
            });
            const config = await loadShareConfig();
            const named = config.targets.filter(({ name }) => name === "remote");
            expect(named).toHaveLength(1);
            const target = named[0];
            if (target.transport.kind !== "paired") {
                throw new Error("fixture target is no longer paired");
            }

            expect(target.transport.deviceId).not.toBe(previous.transport.deviceId);
            expect(await resolveSecret(target.transport.token)).not.toBe(previousToken);
            expect(target.publicBase).toBe(previous.publicBase);
            expect(config.defaults.target).toBe("remote");
            expect((await transportFor(target).check(target)).every(({ ok }) => ok)).toBe(true);
            expect(printed.mock.calls.flat().join("\n")).toContain(
                `dev-dashboard share-server devices --revoke ${previous.transport.deviceId}`
            );
            expect((await server.context.devices.list()).map(({ id }) => id)).toContain(previous.transport.deviceId);
            const audit = await readAudit(clientAuditDir());
            expect(audit.map(({ action, target, status }) => [action, target, status])).toEqual([
                ["pair", "remote", 200],
                ["token-read", "remote", 200],
                ["re-pair", "remote", 200],
                ["token-read", "remote", 200],
                ["token-check", "remote", 200],
            ]);
            expect(audit[0].deviceId).toBe(previous.transport.deviceId);
            expect(audit[2].deviceId).toBe(target.transport.deviceId);
            await server.context.devices.revoke(target.transport.deviceId);
            const rows = await collectShareServerStatus();
            expect(
                rows.find((row) => row.label === "Last pairing attempt" && row.target === "remote")?.detail
            ).toContain("HTTP 200");
            expect(
                rows.find((row) => row.label === "Last failed token check" && row.target === "remote")?.detail
            ).toContain("HTTP 401");
        } finally {
            printed.mockRestore();
            process.exitCode = exitCode;
            await server.stop();
        }
    });
});
