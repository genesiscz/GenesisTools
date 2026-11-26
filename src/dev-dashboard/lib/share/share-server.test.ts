import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_DRIVERS } from "@app/dev-dashboard/lib/share/drivers";
import { ShareConfigSchema, ShareTargetSchema } from "@app/dev-dashboard/lib/share/drivers/options";
import { createPairedDriver } from "@app/dev-dashboard/lib/share/drivers/paired/driver";
import { formatAgo, freshnessTone, isEditedAfterSync } from "@app/dev-dashboard/lib/share/freshness";
import { ADMIN_API, SHARE_API } from "@app/dev-dashboard/lib/share/server/api";
import {
    createShareServerContext,
    handleAdminRequest,
    handleShareRequest,
    parsePublicBase,
    type ShareServerContext,
} from "@app/dev-dashboard/lib/share/server/app";
import { hashToken, MAX_PAIR_FAILURES, ShareDeviceStore } from "@app/dev-dashboard/lib/share/server/devices";
import { installSnapshotUpload } from "@app/dev-dashboard/lib/share/server/upload";
import { SHARE_SNAPSHOT_VERSION, type ShareSnapshotManifest } from "@app/dev-dashboard/lib/share/snapshot";
import { resolveTargets } from "@app/dev-dashboard/lib/share/targets";
import { type ZipEntry, zip } from "@genesiscz/utils/fs/zip";
import { SafeJSON } from "@genesiscz/utils/json";
import type { SecureRef } from "@genesiscz/utils/security";

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

describe("share drivers", () => {
    test("every driver kind the target schema knows has a driver of that kind", () => {
        const kinds: string[] = [];

        for (const option of ShareTargetSchema.options) {
            kinds.push(option.shape.driver.value);
        }

        expect(Object.keys(SHARE_DRIVERS).sort()).toEqual([...kinds].sort());

        for (const [kind, driver] of Object.entries(SHARE_DRIVERS)) {
            expect(String(driver.kind)).toBe(kind);
        }
    });

    test("no --target is the default target, all is every target, an unknown name throws", () => {
        const share = ShareConfigSchema.parse({
            defaults: { target: "pub" },
            targets: [
                { name: "mac", driver: "mac-live" },
                {
                    name: "pub",
                    driver: "ssh-rsync",
                    host: "deploy@share.example.com",
                    dataDir: "/srv/share",
                    publicBase: "https://example.com/share",
                },
            ],
        });

        expect(resolveTargets(share, []).map((target) => target.name)).toEqual(["pub"]);
        expect(resolveTargets(share, ["all"]).map((target) => target.name)).toEqual(["mac", "pub"]);
        expect(() => resolveTargets(share, ["nowhere"])).toThrow('no share target "nowhere"');
    });
});

describe("share server public base", () => {
    test("is an origin plus one path segment, so /md and a later /artifact can share one host", () => {
        expect(parsePublicBase("https://share.example.com/md/")).toEqual({
            origin: "https://share.example.com",
            pagePath: "/md",
        });
        expect(() => parsePublicBase("https://share.example.com/")).toThrow();
        expect(() => parsePublicBase("https://share.example.com/a/b")).toThrow();
    });
});

describe("share server", () => {
    let dir = "";
    let ctx: ShareServerContext;
    let clock = Date.parse("2026-01-01T00:00:00Z");

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "share-server-"));
        ctx = createShareServerContext({
            dataDir: join(dir, "data"),
            stateDir: join(dir, "state"),
            publicBase: "https://share.example.com/share",
        });
        ctx.devices = new ShareDeviceStore(join(dir, "state", "devices.json"), () => clock);
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const request = (path: string, init: RequestInit = {}): Promise<Response> =>
        handleShareRequest(new Request(`http://127.0.0.1:3044${path}`, init), ctx);

    async function pairedToken(): Promise<string> {
        const { code } = ctx.devices.createPairingCode();
        const res = await request(`/share${SHARE_API.pair}`, {
            method: "POST",
            body: SafeJSON.stringify({ code: code.toLowerCase(), deviceName: "laptop" }),
        });
        expect(res.status).toBe(200);
        const body = SafeJSON.parse(await res.text(), { strict: true }) as { token: string };

        return body.token;
    }

    test("a pairing code works once, the server keeps only the token's hash, and the token authenticates", async () => {
        const { code } = ctx.devices.createPairingCode();
        const paired = await ctx.devices.pair(code, "work");

        expect(paired).not.toBeNull();
        expect(await ctx.devices.pair(code, "again")).toBeNull();

        const stored = readFileSync(join(dir, "state", "devices.json"), "utf8");
        expect(stored).not.toContain(paired?.token ?? "missing");
        expect(stored).toContain(hashToken(paired?.token ?? ""));
        expect((await ctx.devices.authenticate(paired?.token ?? ""))?.name).toBe("work");
        expect(await ctx.devices.authenticate("gtshare_not-a-real-token")).toBeNull();
    });

    test("an expired code fails, and enough wrong codes drop every pending code", async () => {
        const expired = ctx.devices.createPairingCode(1000);
        clock += 2000;
        expect(await ctx.devices.pair(expired.code, "late")).toBeNull();

        const live = ctx.devices.createPairingCode();

        for (let attempt = 0; attempt < MAX_PAIR_FAILURES; attempt++) {
            expect(await ctx.devices.pair("WRONG-CODE", "guess")).toBeNull();
        }

        expect(await ctx.devices.pair(live.code, "too late")).toBeNull();
    });

    test("uploads need a paired token; a valid one is served as a page, HEAD has no body, delete removes it", async () => {
        const token = await pairedToken();
        const put = (auth?: string) =>
            request(`/share${SHARE_API.snapshot(SLUG)}`, {
                method: "PUT",
                headers: auth ? { Authorization: `Bearer ${auth}` } : {},
                body: new Uint8Array(snapshotZip()),
            });

        expect((await put()).status).toBe(401);
        expect((await put("gtshare_wrong")).status).toBe(401);
        expect((await put(token)).status).toBe(200);

        const page = await request(`/share/${SLUG}`, { headers: { accept: "text/html" } });
        expect(page.status).toBe(200);
        expect(page.headers.get("X-Share-Server")).toBe("genesis-tools");
        const html = await page.text();
        expect(html).toContain("Fixture Note");
        expect(html).toContain(`/share/${SLUG}?asset=${PICTURE_HASH}`);

        const picture = await request(`/share/${SLUG}?asset=${PICTURE_HASH}`, { headers: { accept: "image/*" } });
        expect(Buffer.from(await picture.arrayBuffer()).equals(PICTURE)).toBe(true);

        const head = await request(`/share/${SLUG}`, { method: "HEAD", headers: { accept: "text/html" } });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");

        const listed = await request(`/share${SHARE_API.snapshots}`, { headers: { Authorization: `Bearer ${token}` } });
        expect(await listed.json()).toEqual({ slugs: [SLUG] });

        const removed = await request(`/share${SHARE_API.snapshot(SLUG)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(removed.status).toBe(200);
        expect((await request(`/share/${SLUG}`)).status).toBe(404);
    });

    test("only /share/<slug> is public: the bare prefix, other paths and other methods answer 404", async () => {
        expect((await request("/share/")).status).toBe(404);
        expect((await request("/share")).status).toBe(404);
        expect((await request("/")).status).toBe(404);
        expect((await request("/api/obsidian/tree")).status).toBe(404);
        expect((await request(`/share/${SLUG}`, { method: "POST" })).status).toBe(404);
    });

    test.each([
        [
            "a path that leaves the folder",
            { extra: [{ name: "zz/escape.txt", data: new Uint8Array([1]) }], escape: true },
        ],
        ["a file a snapshot never holds", { extra: [{ name: "run.sh", data: new Uint8Array([1]) }] }],
        ["a manifest for another slug", { manifest: manifest({ slug: "OtherSlug0123456" }) }],
        ["a listed asset missing from the zip", { skip: `assets/${PICTURE_HASH}.png` }],
        ["no manifest", { skip: "manifest.json" }],
    ])("an upload with %s is refused", async (_label, options) => {
        const body = snapshotZip(options);

        if ("escape" in options) {
            // zip() refuses to write "../", so write "zz/" and turn it into "../" in both headers (same length).
            const text = Buffer.from(body).toString("latin1").replaceAll("zz/escape.txt", "../escape.txt");
            body.set(Buffer.from(text, "latin1"));
        }

        const outcome = await installSnapshotUpload({ dataDir: join(dir, "data"), slug: SLUG, body });

        expect(outcome.ok).toBe(false);
    });

    test("an upload that inflates past the limit is refused before it is written", async () => {
        const bomb = zip([{ name: `assets/${"0".repeat(64)}.png`, data: new Uint8Array(300 * 1024 * 1024) }]);
        const outcome = await installSnapshotUpload({ dataDir: join(dir, "data"), slug: SLUG, body: bomb });

        expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
        expect(outcome).toMatchObject({ ok: false, status: 400 });
    });

    test("the admin socket mints codes and revokes devices; a paired driver trades a code for a vault reference", async () => {
        const minted = await handleAdminRequest(
            new Request(`http://localhost${ADMIN_API.pairCode}`, { method: "POST" }),
            ctx
        );
        const { code } = (await minted.json()) as { code: string };
        const stored = new Map<string, string>();
        const driver = createPairedDriver({
            secrets: async () => ({
                set: async (path: string, value: string): Promise<SecureRef> => {
                    stored.set(path, value);
                    return { type: "secure", path };
                },
                delete: async (path: string) => stored.delete(path),
            }),
            resolveToken: async (ref) => stored.get(ref.path),
            fetch: Object.assign(
                async (input: string | URL | Request, init?: RequestInit) =>
                    handleShareRequest(
                        new Request(String(input).replace("https://share.example.com", "http://127.0.0.1"), init),
                        ctx
                    ),
                { preconnect: fetch.preconnect }
            ),
        });
        const target = await driver.setup({
            name: "pub",
            values: { url: "https://share.example.com/share", code, "device-name": "desk" },
            ask: async (prompt) => {
                throw new Error(`unexpected prompt ${prompt.flag}`);
            },
        });

        expect(target).toMatchObject({
            name: "pub",
            driver: "paired",
            token: { type: "secure", path: "dev-dashboard/share-targets/pub/token" },
        });
        expect(SafeJSON.stringify(target)).not.toContain(
            stored.get("dev-dashboard/share-targets/pub/token") ?? "missing"
        );
        expect(await driver.listSlugs(target)).toEqual([]);

        const devices = (await (
            await handleAdminRequest(new Request(`http://localhost${ADMIN_API.devices}`), ctx)
        ).json()) as {
            devices: Array<{ id: string; name: string; tokenHash?: string }>;
        };
        const desk = devices.devices.find((device) => device.name === "desk");
        expect(desk?.tokenHash).toBeUndefined();

        const revoked = await handleAdminRequest(
            new Request(`http://localhost${ADMIN_API.device(desk?.id ?? "none")}`, { method: "DELETE" }),
            ctx
        );
        expect(revoked.status).toBe(200);
        await expect(driver.listSlugs(target)).rejects.toThrow("HTTP 401");
    });
});
