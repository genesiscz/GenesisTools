import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redeemPairingCode } from "@genesiscz/utils/device-pairing/client";
import { PairCodeResponseSchema } from "@genesiscz/utils/device-pairing/types";
import { type ZipEntry, zip } from "@genesiscz/utils/fs/zip";
import { SafeJSON } from "@genesiscz/utils/json";
import { ADMIN_API, DeviceListSchema, HealthSchema, PUBLISH_API, SnapshotListSchema, WhoamiSchema } from "./api";
import { definePublishedKind, serveKind } from "./kind";
import { ARTIFACT_ENTRY, artifactKind, artifactKindServer, writeArtifactSnapshot } from "./kinds/artifact";
import {
    adminRequest,
    createPublishServerContext,
    DEVICES_FILE,
    handlePublishRequest,
    parsePublicOrigin,
    startPublishServer,
} from "./server";
import {
    checkSnapshotDir,
    installSnapshot,
    listSnapshotIds,
    MAX_SNAPSHOT_FILES,
    migrateFlatDataDir,
    packSnapshot,
    readSnapshotManifestBase,
    SNAPSHOT_MANIFEST,
} from "./snapshot-store";

const ID = "FixtureId";
const SNAPSHOT_AT = "2026-01-01T00:00:00.000Z";
const encoder = new TextEncoder();
const REPORT_HTML = "<!doctype html><title>Weekly report</title>";

const testKind = definePublishedKind({
    id: "demo",
    title: "Demo",
    maxUploadBytes: 1024 * 1024,
    isEntryName: (name) => name !== "refused.txt",
    checkSnapshot: () => ({ ok: true }),
});

function manifestEntry(extra: Record<string, unknown> = {}): ZipEntry {
    return {
        name: SNAPSHOT_MANIFEST,
        data: encoder.encode(SafeJSON.stringify({ title: "Weekly report", snapshotAt: SNAPSHOT_AT, ...extra })),
    };
}

/** The regular writer refuses unsafe names, so replace a checked fixture filename in both ZIP headers. */
function invalidNameZip(name: string): Uint8Array {
    const placeholder = "q".repeat(name.length);
    const body = Buffer.from(zip([manifestEntry(), { name: placeholder, data: encoder.encode("x") }]));
    const first = body.indexOf(placeholder);
    const second = body.indexOf(placeholder, first + placeholder.length);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    body.write(name, first);
    body.write(name, second);
    return body;
}

describe("snapshot store", () => {
    let root: string;
    let dataDir: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "publish-store-"));
        dataDir = join(root, "data");
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    test.each(["../x", "/outside", "x\\escape", "x:y"])("refuses unsafe entry %s before writing", async (name) => {
        const result = await installSnapshot({
            dataDir,
            kind: testKind,
            id: ID,
            body: invalidNameZip(name),
            minFreeBytes: 0,
        });
        expect(result).toMatchObject({ ok: false, status: 400 });
        expect(await readdir(root)).toEqual([]);
    });

    test("refuses names the kind disallows", async () => {
        const body = zip([manifestEntry(), { name: "refused.txt", data: encoder.encode("x") }]);
        expect(await installSnapshot({ dataDir, kind: testKind, id: ID, body, minFreeBytes: 0 })).toMatchObject({
            ok: false,
            status: 400,
        });
        expect(await readdir(root)).toEqual([]);
    });

    test("refuses archives past the expansion and file-count limits before writing", async () => {
        const body = zip([manifestEntry(), { name: "x", data: new Uint8Array(testKind.maxUploadBytes) }]);
        expect(body.byteLength).toBeLessThan(testKind.maxUploadBytes);
        expect(await installSnapshot({ dataDir, kind: testKind, id: ID, body, minFreeBytes: 0 })).toMatchObject({
            ok: false,
            status: 400,
        });

        const many = Array.from({ length: MAX_SNAPSHOT_FILES }, (_, index) => ({
            name: `x${index}`,
            data: new Uint8Array(),
        }));
        const tooMany = zip([manifestEntry(), ...many]);
        expect(await installSnapshot({ dataDir, kind: testKind, id: ID, body: tooMany, minFreeBytes: 0 })).toEqual({
            ok: false,
            status: 400,
            error: "too many files in snapshot",
        });
        expect(await readdir(root)).toEqual([]);
    });

    test("reserves disk space before writing", async () => {
        const body = zip([manifestEntry()]);
        const result = await installSnapshot({
            dataDir,
            kind: testKind,
            id: ID,
            body,
            minFreeBytes: Number.MAX_SAFE_INTEGER,
        });
        expect(result).toMatchObject({ ok: false, status: 507 });
        expect(await readdir(root)).toEqual([]);
    });

    test("installs a valid snapshot and replaces the previous folder", async () => {
        const input = { dataDir, kind: testKind, id: ID, minFreeBytes: 0 };
        const first = zip([manifestEntry(), { name: "old.txt", data: encoder.encode("old") }]);
        expect(await installSnapshot({ ...input, body: first })).toEqual({ ok: true, title: "Weekly report" });
        const second = zip([manifestEntry({ title: "New report", custom: true })]);
        expect(await installSnapshot({ ...input, body: second })).toEqual({ ok: true, title: "New report" });
        expect(await readdir(join(dataDir, "demo", ID))).toEqual([SNAPSHOT_MANIFEST]);
        expect(await listSnapshotIds({ dataDir, kind: "demo" })).toEqual([ID]);
        const expected = { title: "New report", snapshotAt: SNAPSHOT_AT, custom: true };
        expect(await readSnapshotManifestBase({ dataDir, kind: "demo", id: ID })).toEqual(expected);
    });

    test("moves two flat snapshots once and leaves named kind folders where they are", async () => {
        const fixture = ["alpha", "beta", "artifact"];
        for (const id of fixture) {
            const dir = join(dataDir, id);
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, SNAPSHOT_MANIFEST), manifestEntry().data);
        }

        const input = { dataDir, kind: "md", kindIds: ["md", "artifact"] };
        expect(await migrateFlatDataDir(input)).toEqual(["alpha", "beta"]);
        expect(await migrateFlatDataDir(input)).toEqual([]);
        expect((await readdir(dataDir)).sort()).toEqual(["artifact", "md"]);
        expect(await listSnapshotIds({ dataDir, kind: "md" })).toEqual(["alpha", "beta"]);
    });

    test("checks, packs and serves the artifact HTML, and refuses a third file", async () => {
        const dir = join(root, "build");
        await mkdir(dir);
        await writeArtifactSnapshot({
            dir,
            id: ID,
            title: "Weekly report",
            html: encoder.encode(REPORT_HTML),
            sourceName: "report.tsx",
        });
        expect(await checkSnapshotDir({ kind: artifactKind, id: ID, dir })).toEqual({ ok: true });

        const input = { dataDir, kind: artifactKind, id: ID, minFreeBytes: 0 };
        const first = await packSnapshot(dir);
        expect(await installSnapshot({ ...input, body: first })).toEqual({ ok: true, title: "Weekly report" });

        await writeFile(join(dir, "third.txt"), "refuse");
        expect(await checkSnapshotDir({ kind: artifactKind, id: ID, dir })).toMatchObject({ ok: false });
        expect(await installSnapshot({ ...input, body: await packSnapshot(dir) })).toMatchObject({
            ok: false,
            status: 400,
        });

        const url = new URL(`https://share.example.com/artifact/${ID}?download=1`);
        const kindDir = join(dataDir, "artifact");
        const response = await artifactKindServer.serve({
            request: new Request(url),
            url,
            id: ID,
            rest: "",
            kindDir,
            origin: url.origin,
        });
        expect(response?.status).toBe(200);
        expect(await response?.text()).toBe(REPORT_HTML);
        expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(response?.headers.get("cache-control")).toBe("no-store");
        expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response?.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Weekly%20report.html");
        const saved = await readSnapshotManifestBase({ dataDir, kind: "artifact", id: ID });
        expect(response?.headers.get("last-modified")).toBe(new Date(saved?.snapshotAt ?? "").toUTCString());
        expect(await readFile(join(kindDir, ID, ARTIFACT_ENTRY), "utf8")).toBe(REPORT_HTML);
    });
});

describe("publish server", () => {
    let root: string;
    let dataDir: string;
    let stateDir: string;
    const demo = serveKind(testKind, async ({ request, id, rest, kindDir, origin }) => {
        if (id === "error") {
            throw new Error("private fixture exception");
        }

        if (id === "fixture") {
            return new Response(`${request.method} ${origin}/demo/${id}${rest}`);
        }

        const file = Bun.file(join(kindDir, id, "demo.txt"));
        return (await file.exists()) ? new Response(file) : null;
    });
    const publicBase = "https://share.example.com/demo";
    const kinds = [demo, artifactKindServer];

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "publish-server-"));
        dataDir = join(root, "data");
        stateDir = join(root, "state");
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    function assertHeaders(response: Response): Response {
        expect(response.headers.get("x-share-server")).toBe("genesis-tools");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        return response;
    }

    test("accepts the origin and known old bases", () => {
        const ids = ["demo", "artifact"];
        expect(parsePublicOrigin(publicBase, ids)).toBe("https://share.example.com");
        expect(parsePublicOrigin("https://share.example.com/", ids)).toBe("https://share.example.com");
        expect(() => parsePublicOrigin("https://share.example.com/demo/extra", ids)).toThrow("demo, artifact");
        expect(() => parsePublicOrigin("https://share.example.com/other", ids)).toThrow("demo, artifact");
        expect(() => parsePublicOrigin("file:///demo", ids)).toThrow("HTTP(S)");
    });

    test("routes the five public methods, handles errors and authenticates before reading any upload", async () => {
        const context = createPublishServerContext({ kinds, publicBase, dataDir, stateDir });
        const request = (path: string, init?: RequestInit) => new Request(new URL(path, publicBase), init);
        const handle = async (req: Request) => assertHeaders(await handlePublishRequest(req, context));
        expect(HealthSchema.parse(await (await handle(request(PUBLISH_API.health))).json()).kinds).toEqual([
            "demo",
            "artifact",
        ]);
        expect(await (await handle(request("/robots.txt"))).text()).toContain("Disallow: /");
        expect(await (await handle(request("/demo/fixture/extra"))).text()).toBe(
            "GET https://share.example.com/demo/fixture/extra"
        );
        expect((await handle(request("/demo/fixture", { method: "HEAD" }))).body).toBeNull();

        const pairUrl = request(PUBLISH_API.pair, {
            method: "POST",
            body: SafeJSON.stringify({ code: "WRONG-CODE", deviceName: "desk" }),
        });
        expect((await handle(pairUrl)).status).toBe(403);
        expect((await handle(request(PUBLISH_API.pair, { method: "POST", body: "wrong-json" }))).status).toBe(400);
        expect((await handle(request(PUBLISH_API.pair, { method: "POST", body: " ".repeat(4097) }))).status).toBe(413);

        for (const [path, method] of [
            ["/unknown/fixture", "GET"],
            ["/demo/fixture", "POST"],
            ["/demo/bad!id", "GET"],
            [PUBLISH_API.health, "POST"],
            [PUBLISH_API.pair, "GET"],
            ["/robots.txt", "POST"],
        ]) {
            expect((await handle(request(path, { method }))).status).toBe(404);
        }

        const failed = await handle(request("/demo/error"));
        expect(failed.status).toBe(500);
        expect(await failed.text()).toBe("the request failed");

        const unauthenticated = request(PUBLISH_API.snapshot("demo", ID), { method: "PUT", body: "unread" });
        expect((await handle(unauthenticated)).status).toBe(401);
        expect(unauthenticated.bodyUsed).toBe(false);
        expect((await handle(request(PUBLISH_API.whoami))).status).toBe(401);
        expect((await handle(request("/unknown/_api/elsewhere"))).status).toBe(401);
        expect(await readdir(root)).toEqual(["state"]);
        expect(await readdir(stateDir)).toEqual(["audit.jsonl"]);
    });

    test("migrates the old page and pairs, lists, serves and revokes over real sockets", async () => {
        const legacyDir = join(dataDir, "legacy");
        await mkdir(legacyDir, { recursive: true });
        await writeFile(join(legacyDir, SNAPSHOT_MANIFEST), manifestEntry().data);
        await writeFile(join(legacyDir, "demo.txt"), "legacy page");

        const server = await startPublishServer({
            kinds,
            publicBase,
            dataDir,
            stateDir,
            minFreeBytes: 0,
            legacyFlatKind: "demo",
            host: "127.0.0.1",
            port: 0,
        });
        try {
            const get = async (path: string, init?: RequestInit) =>
                assertHeaders(await fetch(new URL(path, server.url), init));
            expect((await stat(server.adminSocket)).mode & 0o777).toBe(0o600);
            expect(await (await get("/demo/legacy")).text()).toBe("legacy page");
            expect(await readdir(dataDir)).toEqual(["demo"]);

            const { code } = PairCodeResponseSchema.parse(
                await adminRequest({ stateDir, path: ADMIN_API.pairCode, method: "POST" })
            );
            const { deviceId, token } = await redeemPairingCode({ url: server.url, code, deviceName: "desk" });
            const headers = { Authorization: `Bearer ${token}` };
            const file = join(stateDir, DEVICES_FILE);
            const saved = await readFile(file, "utf8");

            expect(WhoamiSchema.parse(await (await get(PUBLISH_API.whoami, { headers })).json())).toEqual({
                deviceId,
                name: "desk",
            });
            const list = PUBLISH_API.snapshots("artifact");
            expect(SnapshotListSchema.parse(await (await get(list, { headers })).json()).ids).toEqual([]);
            expect((await get("/artifact/_api/other", { headers })).status).toBe(404);
            expect(await readFile(file, "utf8")).toBe(saved);

            const body = zip([
                manifestEntry({ version: 1, id: ID, sourceName: "report.tsx" }),
                { name: ARTIFACT_ENTRY, data: encoder.encode(REPORT_HTML) },
            ]);
            const snapshot = PUBLISH_API.snapshot("artifact", ID);
            const put = await get(snapshot, { method: "PUT", headers, body: Uint8Array.from(body) });
            expect(put.status).toBe(200);
            expect(await put.json()).toEqual({ id: ID, title: "Weekly report" });
            expect(SnapshotListSchema.parse(await (await get(list, { headers })).json()).ids).toEqual([ID]);
            expect(await (await get(`/artifact/${ID}`)).text()).toBe(REPORT_HTML);
            const head = await get(`/artifact/${ID}`, { method: "HEAD" });
            expect(head.status).toBe(200);
            expect(await head.text()).toBe("");
            expect((await get(`/artifact/${ID}/extra`)).status).toBe(404);
            expect((await get(snapshot, { method: "DELETE", headers })).status).toBe(200);
            expect((await get(`/artifact/${ID}`)).status).toBe(404);

            const devices = DeviceListSchema.parse(await adminRequest({ stateDir, path: ADMIN_API.devices })).devices;
            expect(devices).toEqual([expect.objectContaining({ id: deviceId, lastUsedAt: expect.any(String) })]);
            expect(await adminRequest({ stateDir, path: ADMIN_API.device(deviceId), method: "DELETE" })).toEqual({
                revoked: deviceId,
            });
            expect((await get(PUBLISH_API.whoami, { headers })).status).toBe(401);
        } finally {
            await server.stop();
        }
    });
});
