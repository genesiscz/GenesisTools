import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairCodeResponseSchema, PairResponseSchema } from "@genesiscz/utils/device-pairing/types";
import { zip } from "@genesiscz/utils/fs/zip";
import { SafeJSON } from "@genesiscz/utils/json";
import { ADMIN_API, PUBLISH_API } from "./api";
import { AUDIT_FILE, clientAddress, readAudit, recordAudit } from "./audit";
import { definePublishedKind, serveKind } from "./kind";
import { ARTIFACT_ENTRY, artifactKindServer } from "./kinds/artifact";
import { adminRequest, createPublishServerContext, DEVICES_FILE, startPublishServer } from "./server";
import { SNAPSHOT_MANIFEST } from "./snapshot-store";

const ID = "FixtureId";
const REJECTED_CODE = "1111-1111";
const PAGE = "<!doctype html><title>Report</title>";
const CSP = "default-src 'none'";
const stamp = "2026-01-01T00:00:00.000Z";
const demo = serveKind(
    definePublishedKind({
        id: "demo",
        title: "Demo",
        maxUploadBytes: 1024,
        isEntryName: () => true,
        checkSnapshot: () => ({ ok: true }),
    }),
    async ({ rest }) => {
        const headers = { "Content-Security-Policy": CSP };
        if (rest === "") {
            return new Response(PAGE, { headers: { ...headers, "Content-Type": "text/html" } });
        }

        return rest === "/chart.bin" ? new Response(new Uint8Array([1, 2, 3]), { headers }) : null;
    }
);

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "publish-audit-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("writes one redacted audit row per page, asset, pairing, admin, upload and removal", async () => {
    const stateDir = join(root, "state");
    const server = await startPublishServer({
        host: "127.0.0.1",
        port: 0,
        kinds: [demo, artifactKindServer],
        publicBase: "https://share.example.com",
        trustProxy: true,
        dataDir: join(root, "data"),
        stateDir,
        minFreeBytes: 0,
    });
    try {
        expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
        expect((await stat(server.adminSocket)).mode & 0o777).toBe(0o600);

        const get = (path: string, init?: RequestInit) => fetch(new URL(path, server.url), init);
        const { code } = PairCodeResponseSchema.parse(
            await adminRequest({ stateDir, method: "POST", path: ADMIN_API.pairCode })
        );
        const pair = (code: string, userAgent: string) =>
            get(PUBLISH_API.pair, {
                method: "POST",
                headers: { "User-Agent": userAgent },
                body: SafeJSON.stringify({ code, deviceName: "desk" }),
            });
        const refused = await pair(REJECTED_CODE, REJECTED_CODE);
        expect(refused.status).toBe(403);
        await refused.text();
        const { deviceId, token } = PairResponseSchema.parse(await (await pair(code, `fixture ${code}`)).json());
        const tokenHash = SafeJSON.parse(await readFile(join(stateDir, DEVICES_FILE), "utf8")).devices[0].tokenHash;
        expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);

        const bad = await get(PUBLISH_API.whoami, { headers: { Authorization: "Bearer wrong-token" } });
        expect(bad.status).toBe(401);
        await bad.text();
        const headers = {
            Authorization: `Bearer ${token}`,
            "User-Agent": `${token} ${tokenHash} ${"a".repeat(250)}`,
            "X-Forwarded-For": "192.0.2.10, 198.51.100.8",
        };
        const page = await get(`/demo/${ID}?secret=fixture-query`, { headers });
        expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(page.headers.get("Content-Security-Policy")).toBe(CSP);
        expect(await page.text()).toBe(PAGE);

        const asset = await get(`/demo/${ID}/chart.bin`);
        expect(asset.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(asset.headers.get("Content-Security-Policy")).toBe(CSP);
        expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        const directory = await get(`/demo/${ID}/folder/`);
        expect(directory.status).toBe(404);
        await directory.text();

        const enc = new TextEncoder();
        const body = zip([
            {
                name: SNAPSHOT_MANIFEST,
                data: enc.encode(
                    SafeJSON.stringify({
                        version: 1,
                        id: ID,
                        title: "Report",
                        snapshotAt: stamp,
                        sourceName: "report.html",
                    })
                ),
            },
            { name: ARTIFACT_ENTRY, data: enc.encode(PAGE) },
        ]);
        const snapshot = PUBLISH_API.snapshot("artifact", ID);
        for (const method of ["PUT", "DELETE"]) {
            const response = await get(snapshot, {
                method,
                headers,
                body: method === "PUT" ? new Uint8Array(body) : undefined,
            });
            expect(response.status).toBe(200);
            await response.json();
        }

        const entries = await readAudit(stateDir);
        expect(entries.map(({ action, method, path, status }) => [action, method, path, status])).toEqual([
            ["admin", "POST", ADMIN_API.pairCode, 200],
            ["pair", "POST", PUBLISH_API.pair, 403],
            ["pair", "POST", PUBLISH_API.pair, 200],
            ["request", "GET", PUBLISH_API.whoami, 401],
            ["request", "GET", `/demo/${ID}`, 200],
            ["request", "GET", `/demo/${ID}/chart.bin`, 200],
            ["request", "GET", `/demo/${ID}/folder/`, 404],
            ["request", "PUT", snapshot, 200],
            ["request", "DELETE", snapshot, 200],
        ]);
        expect(entries[4]).toMatchObject({
            side: "server",
            kind: "demo",
            id: ID,
            bytesOut: Buffer.byteLength(PAGE),
            deviceId,
            deviceName: "desk",
            address: "198.51.100.8",
            time: expect.any(String),
            durationMs: expect.any(Number),
        });
        expect(entries[4].userAgent).toHaveLength(200);
        expect(entries[4].userAgent).toContain("[redacted]");
        expect(entries[5].bytesOut).toBe(3);
        expect(entries[7]).toMatchObject({ kind: "artifact", id: ID, deviceId, deviceName: "desk" });
        const raw = await readFile(join(stateDir, AUDIT_FILE), "utf8");
        for (const secret of [token, tokenHash, code, REJECTED_CODE, "wrong-token", "fixture-query", PAGE]) {
            expect(raw).not.toContain(secret);
        }

        expect((await stat(join(stateDir, AUDIT_FILE))).mode & 0o777).toBe(0o600);
    } finally {
        await server.stop();
    }
});

test("limits a forwarded address on its sixth try and keeps the audit record", async () => {
    const stateDir = join(root, "state");
    const server = await startPublishServer({
        host: "127.0.0.1",
        port: 0,
        kinds: [demo],
        publicBase: "https://share.example.com",
        trustProxy: true,
        dataDir: join(root, "data"),
        stateDir,
    });
    const pending = server.context.devices.createPairingCode().code;
    try {
        for (let index = 1; index <= 7; index++) {
            const forwarded = index === 7 ? "198.51.100.99" : "198.51.100.8";
            const result = await fetch(new URL(PUBLISH_API.pair, server.url), {
                method: "POST",
                headers: { "X-Forwarded-For": `192.0.2.${index}, ${forwarded}` },
                body: SafeJSON.stringify({ code: REJECTED_CODE, deviceName: "desk" }),
            });
            expect(result.status).toBe(index === 6 ? 429 : 403);
            if (index === 6) {
                expect(result.headers.get("Retry-After")).toBe("600");
            }

            await result.text();
        }

        const entries = await readAudit(stateDir, { limit: 2 });
        expect(entries.map(({ address, action, status }) => [address, action, status])).toEqual([
            ["198.51.100.8", "pair", 429],
            ["198.51.100.99", "pair", 403],
        ]);
        expect(clientAddress("198.51.100.7", "198.51.100.10")).toBe("198.51.100.7");
        expect(clientAddress("127.0.0.1", "198.51.100.10")).toBe("127.0.0.1");
        expect(clientAddress("127.0.0.1", "198.51.100.10", { trustProxy: true })).toBe("198.51.100.10");
        expect(clientAddress("::1", "invalid")).toBe("::1");
        const valid = await fetch(new URL(PUBLISH_API.pair, server.url), {
            method: "POST",
            headers: { "X-Forwarded-For": "198.51.100.100" },
            body: SafeJSON.stringify({ code: pending, deviceName: "other-desk" }),
        });
        expect(valid.status).toBe(200);
        expect(PairResponseSchema.parse(await valid.json()).deviceId).toBeTruthy();
    } finally {
        await server.stop();
    }
});

test.skipIf(process.platform === "win32")("an existing loose audit file is restricted before rotation", async () => {
    const file = join(root, AUDIT_FILE);
    await writeFile(file, "older record\n");
    await chmod(file, 0o644);
    await recordAudit(
        root,
        {
            time: new Date().toISOString(),
            side: "client",
            action: "publish",
            status: 200,
            durationMs: 1,
        },
        { maxBytes: 1 }
    );
    expect(await readFile(`${file}.1`, "utf8")).toBe("older record\n");
    expect((await stat(`${file}.1`)).mode & 0o777).toBe(0o600);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("pairing capacity is reclaimed when the earliest occupied slot expires", async () => {
    const time = spyOn(Date, "now").mockReturnValue(1);
    try {
        const context = createPublishServerContext({
            kinds: [demo],
            dataDir: join(root, "data"),
            stateDir: join(root, "state"),
            publicBase: "https://share.example.com",
        });
        for (let index = 0; index < 10_000; index++) {
            expect(context.pairRateLimit.allow(`fixture-${index}`)).toBe(true);
        }

        time.mockReturnValue(600_000);
        expect(context.pairRateLimit.allow("blocked")).toBe(false);
        time.mockReturnValue(600_001);
        expect(context.pairRateLimit.allow("new-address")).toBe(true);
    } finally {
        time.mockRestore();
    }
});

test("rotates at the configured size and reads new and rotated files in order", async () => {
    for (let day = 1; day <= 12; day++) {
        await recordAudit(
            root,
            {
                side: "client",
                action: "publish",
                time: new Date(Date.UTC(2026, 0, day)).toISOString(),
                deviceId: day % 2 ? "desk" : "relay",
                status: 200,
                durationMs: 1,
            },
            { maxBytes: 1 }
        );
    }

    const files = (await readdir(root)).sort();
    expect(files).toEqual([AUDIT_FILE, ...Array.from({ length: 9 }, (_, ix) => `${AUDIT_FILE}.${ix + 1}`)]);
    for (const path of files) {
        expect((await stat(join(root, path))).isFile()).toBe(true);
        if (process.platform !== "win32") {
            expect((await stat(join(root, path))).mode & 0o777).toBe(0o600);
        }
    }

    const recent = await readAudit(root, { device: "desk", since: new Date("2026-01-09") });
    expect(recent.map(({ time }) => time.slice(0, 10))).toEqual(["2026-01-09", "2026-01-11"]);
});
