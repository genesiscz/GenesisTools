import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectShareServerStatus } from "@app/dev-dashboard/commands/share-server";
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
    shareConfigPath,
    updateShareConfig,
} from "@genesiscz/utils/genesis-tools/publish/store";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { PUBLISH_API } from "@genesiscz/utils/publish/api";
import { startPublishServer } from "@genesiscz/utils/publish/server";
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
        expect(formatAgo(30_000)).toBe("just now");
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
        } finally {
            printed.mockRestore();
            process.exitCode = exitCode;
            await server.stop();
        }
    });
});
