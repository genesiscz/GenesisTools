import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, importSet } from "@app/dev-dashboard/lib/boards/boards-store";
import { getBoardsDb, resetBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { resetEventHub, subscribeBoard } from "@app/dev-dashboard/lib/boards/events";
import { getSet } from "@app/dev-dashboard/lib/boards/sets-store";
import { tarGz } from "@app/dev-dashboard/lib/boards/tar";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { boardsSetsRoutes } from "./boards-sets";

function findRoute(method: string, pattern: string): RouteDef {
    const def = boardsSetsRoutes().find((d) => d.method === method && d.pattern === pattern);

    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }

    return def;
}

function makeCtx(opts: {
    method?: RouteContext["method"];
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    rawBody?: Uint8Array;
}): RouteContext {
    return {
        method: opts.method ?? "GET",
        pathname: "/",
        query: new URLSearchParams(opts.query ?? {}),
        params: opts.params ?? {},
        headers: {},
        readJson: async <T>() => opts.body as T,
        readRawBody: async () => opts.rawBody ?? new TextEncoder().encode(SafeJSON.stringify(opts.body ?? {})),
        services: {} as RouteContext["services"],
    };
}

function asJson(result: RouteResult): { status: number; body: Record<string, unknown> } {
    if (result.kind !== "json") {
        throw new Error(`expected json result, got ${result.kind}`);
    }

    return { status: result.status, body: result.body as Record<string, unknown> };
}

function u32be(n: number): number[] {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function buildPng(width: number, height: number): Uint8Array {
    return new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0x00,
        0x00,
        0x00,
        0x0d,
        0x49,
        0x48,
        0x44,
        0x52,
        ...u32be(width),
        ...u32be(height),
        0x08,
        0x06,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
    ]);
}

async function putContent(
    project: string,
    branch: string,
    key: string,
    entries: Array<{ path: string; data: Uint8Array }>
): Promise<{ status: number; body: Record<string, unknown> }> {
    const put = findRoute("PUT", "/api/boards/sets/:project/:branch/:key/content");
    const gz = await tarGz(entries);
    return asJson(await put.handler(makeCtx({ method: "PUT", params: { project, branch, key }, rawBody: gz })));
}

describe("boardsSetsRoutes", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "boards-sets-route-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        env.testing.set("BOARDS_DB_PATH", ":memory:");
        resetDevDashboardStorage();
        resetBoardsDb();
        resetEventHub();
    });

    afterEach(() => {
        resetEventHub();
        resetBoardsDb();
        resetDevDashboardStorage();
        env.testing.unset("GENESIS_TOOLS_HOME");
        env.testing.unset("BOARDS_DB_PATH");
        rmSync(dir, { recursive: true, force: true });
    });

    it("PUT content: first push 201, re-push 200 with the same version and replaced file rows", async () => {
        const first = await putContent("proj", "main", "s1", [
            { path: "a.png", data: buildPng(320, 200) },
            { path: "b.png", data: buildPng(100, 50) },
        ]);
        expect(first.status).toBe(201);
        expect(first.body.created).toBe(true);
        expect(first.body.version).toBe(1);
        expect(first.body.files).toBe(2);

        const second = await putContent("proj", "main", "s1", [{ path: "a.png", data: buildPng(320, 200) }]);
        expect(second.status).toBe(200);
        expect(second.body.created).toBe(false);
        expect(second.body.version).toBe(1);
        expect(second.body.files).toBe(1);
    });

    it("PUT of a new key under the same project/branch publishes set_version to boards holding older-key cards", async () => {
        const db = getBoardsDb();
        // K1 push + import: board b1 now holds a version-1 shot card.
        await putContent("proj", "main", "s1", [{ path: "a.png", data: buildPng(320, 200) }]);
        await createBoard(db, { slug: "b1" });
        await importSet(db, "b1", await getSet(db, "proj", "main", "s1"));

        const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const unsub = subscribeBoard("b1", (frame) => frames.push(SafeJSON.parse(frame, { strict: true })));

        // K2 is a NEW key under the same (proj, main) → shared counter mints version 2 → strands b1's card.
        await putContent("proj", "main", "s2", [{ path: "a.png", data: buildPng(400, 260) }]);
        unsub();

        const setVersionEvents = frames.filter((f) => f.type === "set_version");
        expect(setVersionEvents.length).toBeGreaterThanOrEqual(1);
        expect(setVersionEvents[0].payload).toMatchObject({ project: "proj", branch: "main", version: 2, key: "s2" });
    });

    it("rejects an invalid or reserved set key with 400", async () => {
        const put = findRoute("PUT", "/api/boards/sets/:project/:branch/:key/content");
        const gz = await tarGz([{ path: "a.png", data: buildPng(1, 1) }]);
        const res = await put.handler(
            makeCtx({ method: "PUT", params: { project: "p", branch: "main", key: "latest" }, rawBody: gz })
        );
        expect(asJson(res).status).toBe(400);
    });

    it("GET selector chain: version, latest, key, and name (after PATCH)", async () => {
        await putContent("proj", "main", "s1", [{ path: "a.png", data: buildPng(1, 1) }]);
        await putContent("proj", "main", "s2", [{ path: "b.png", data: buildPng(1, 1) }]);

        const getByVersion = findRoute("GET", "/api/boards/sets/:project/:branch/:selector");
        const byVersion = asJson(
            await getByVersion.handler(makeCtx({ params: { project: "proj", branch: "main", selector: "1" } }))
        );
        expect(byVersion.status).toBe(200);
        expect(byVersion.body.key).toBe("s1");

        const byLatest = asJson(
            await getByVersion.handler(makeCtx({ params: { project: "proj", branch: "main", selector: "latest" } }))
        );
        expect(byLatest.body.key).toBe("s2");

        const patch = findRoute("PATCH", "/api/boards/sets/:project/:branch/:selector");
        const patched = asJson(
            await patch.handler(
                makeCtx({
                    method: "PATCH",
                    params: { project: "proj", branch: "main", selector: "s1" },
                    body: { name: "cool" },
                })
            )
        );
        expect(patched.status).toBe(200);

        const byName = asJson(
            await getByVersion.handler(makeCtx({ params: { project: "proj", branch: "main", selector: "cool" } }))
        );
        expect(byName.body.key).toBe("s1");
    });

    it("PATCH name conflict returns 409", async () => {
        await putContent("proj", "main", "s1", [{ path: "a.png", data: buildPng(1, 1) }]);
        await putContent("proj", "main", "s2", [{ path: "b.png", data: buildPng(1, 1) }]);
        const patch = findRoute("PATCH", "/api/boards/sets/:project/:branch/:selector");
        await patch.handler(
            makeCtx({
                method: "PATCH",
                params: { project: "proj", branch: "main", selector: "s1" },
                body: { name: "taken" },
            })
        );
        const conflict = asJson(
            await patch.handler(
                makeCtx({
                    method: "PATCH",
                    params: { project: "proj", branch: "main", selector: "s2" },
                    body: { name: "taken" },
                })
            )
        );
        expect(conflict.status).toBe(409);
    });

    it("blob GET round-trips bytes with an immutable cache header; traversal key 404s", async () => {
        const pushed = await putContent("proj", "main", "s1", [{ path: "a.png", data: buildPng(10, 10) }]);
        const getDetail = findRoute("GET", "/api/boards/sets/:project/:branch/:selector");
        const detail = asJson(
            await getDetail.handler(makeCtx({ params: { project: "proj", branch: "main", selector: "s1" } }))
        );
        const files = detail.body.files as Array<{ blobKey: string; url: string }>;
        expect(files[0].url).toBe(`/api/boards/blobs/${files[0].blobKey}`);

        const getBlob = findRoute("GET", "/api/boards/blobs/:key");
        const blobResult = await getBlob.handler(makeCtx({ params: { key: files[0].blobKey } }));
        expect(blobResult.kind).toBe("binary");
        if (blobResult.kind === "binary") {
            expect(blobResult.body).toEqual(buildPng(10, 10));
            expect(blobResult.headers?.["Cache-Control"]).toBe("public, max-age=31536000, immutable");
        }

        const notFound = await getBlob.handler(makeCtx({ params: { key: "../../etc/passwd" } }));
        expect(asJson(notFound).status).toBe(404);
        expect(pushed.status).toBe(201);
    });

    it("POST /api/boards/sets mints a fresh key", async () => {
        const mint = findRoute("POST", "/api/boards/sets");
        const res = asJson(await mint.handler(makeCtx({ method: "POST", body: { project: "proj", branch: "main" } })));
        expect(res.status).toBe(200);
        expect(typeof res.body.key).toBe("string");
        expect(res.body.key as string).toMatch(/^s-\d{8}-\d{4}$/);
    });

    it("GET /api/boards/projects aggregates branches and sets", async () => {
        await putContent("proj", "main", "s1", [{ path: "a.png", data: buildPng(1, 1) }]);
        await putContent("proj", "feature-x", "s1", [{ path: "a.png", data: buildPng(1, 1) }]);
        const list = findRoute("GET", "/api/boards/projects");
        const res = asJson(await list.handler(makeCtx({})));
        const projects = res.body.projects as Array<{ project: string; branches: number; sets: number }>;
        const proj = projects.find((p) => p.project === "proj");
        expect(proj?.branches).toBe(2);
        expect(proj?.sets).toBe(2);
    });

    it("GET/PUT operator round-trips and defaults to empty", async () => {
        const get = findRoute("GET", "/api/boards/operator");
        const empty = asJson(await get.handler(makeCtx({})));
        expect(empty.body.operator).toBe("");

        const put = findRoute("PUT", "/api/boards/operator");
        const updated = asJson(await put.handler(makeCtx({ method: "PUT", body: { operator: "martin" } })));
        expect(updated.body.operator).toBe("martin");

        const after = asJson(await get.handler(makeCtx({})));
        expect(after.body.operator).toBe("martin");
    });
});
