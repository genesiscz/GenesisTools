import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ZipEntry, zip } from "@genesiscz/utils/fs/zip";
import { SafeJSON } from "@genesiscz/utils/json";
import { definePublishedKind } from "./kind";
import { ARTIFACT_ENTRY, artifactKind, artifactKindServer, writeArtifactSnapshot } from "./kinds/artifact";
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
