import { blobPath, blobUrl, mimeForPath } from "@app/dev-dashboard/lib/boards/blobs";
import { getBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { publishBoardEvent } from "@app/dev-dashboard/lib/boards/events";
import {
    getSet,
    isReservedKey,
    KEY_RE,
    listProjects,
    listSets,
    mintKey,
    patchSet,
    slugifyBranch,
    syncSet,
} from "@app/dev-dashboard/lib/boards/sets-store";
import { untarGz } from "@app/dev-dashboard/lib/boards/tar";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { escapeLike } from "@app/utils/database/predicates";
import { type SqlBool, sql } from "kysely";
import { boardsError } from "./boards-errors";

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Reads the `operator` settings row — the fallback actor identity for board writes that
 *  arrive without an `x-board-actor` header (see boards-annotations.ts's actorFrom). */
export async function getOperator(): Promise<string> {
    const db = getBoardsDb();
    const row = await db.kysely.selectFrom("settings").select("value").where("key", "=", "operator").executeTakeFirst();
    return row?.value ?? "";
}

async function setOperator(operator: string): Promise<void> {
    const db = getBoardsDb();
    await db.kysely
        .insertInto("settings")
        .values({ key: "operator", value: operator })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: operator }))
        .execute();
}

/** Publishes `set_version` to every board holding a live shot card from this (project, branch)
 *  at a version below the one just pushed. Scope is the whole prefix, not the new key's exact ref:
 *  the version counter is shared per (project, branch), so a fresh key strands older keys' cards
 *  (mirrors store.BoardsWithStaleCards, boards.go:892-899). */
async function notifyStaleCards(opts: {
    project: string;
    branch: string;
    key: string;
    version: number;
}): Promise<void> {
    const { project, branch, key, version } = opts;
    const db = getBoardsDb();
    const pattern = `${escapeLike(`${project}/${branch}/`)}%`;
    const stale = await db.kysely
        .selectFrom("board_cards")
        .innerJoin("boards", "boards.id", "board_cards.board_id")
        .select(["boards.slug"])
        .where("board_cards.kind", "=", "shot")
        .where(sql<SqlBool>`board_cards.set_ref LIKE ${pattern} ESCAPE '\\'`)
        .where("board_cards.deleted_at", "=", "")
        .where("board_cards.set_version", "<", version)
        .groupBy("boards.slug")
        .execute();
    for (const row of stale) {
        publishBoardEvent(row.slug, { type: "set_version", payload: { project, branch, version, key } });
    }
}

export function boardsSetsRoutes(): RouteDef[] {
    return [
        {
            method: "PUT",
            pattern: "/api/boards/sets/:project/:branch/:key/content",
            handler: async (ctx) => {
                const { project, branch, key } = ctx.params;
                if (!KEY_RE.test(key) || isReservedKey(key)) {
                    return { kind: "json", status: 400, body: { error: `invalid set key: ${key}` } };
                }

                const raw = await ctx.readRawBody();
                if (raw.length > MAX_UPLOAD_BYTES) {
                    return { kind: "json", status: 413, body: { error: "upload too large (max 200 MiB)" } };
                }

                let entries: Awaited<ReturnType<typeof untarGz>>;
                try {
                    entries = await untarGz(raw);
                } catch (err) {
                    return {
                        kind: "json",
                        status: 400,
                        body: { error: `unparseable tar.gz: ${err instanceof Error ? err.message : String(err)}` },
                    };
                }

                const branchRaw = ctx.query.get("branch") || branch;
                try {
                    const result = await syncSet(getBoardsDb(), {
                        project,
                        branchRaw,
                        key,
                        kind: ctx.query.get("kind") ?? undefined,
                        title: ctx.query.get("title") ?? undefined,
                        commitSha: ctx.query.get("commit") ?? undefined,
                        repo: ctx.query.get("repo") ?? undefined,
                        sourceRef: ctx.query.get("source") ?? undefined,
                        entries,
                    });

                    await notifyStaleCards({
                        project: result.set.project,
                        branch: result.set.branch,
                        key: result.set.key,
                        version: result.set.version,
                    });

                    return {
                        kind: "json",
                        status: result.created ? 201 : 200,
                        body: {
                            url: `/boards-sets/${result.set.project}/${result.set.branch}/${result.set.version}`,
                            project: result.set.project,
                            branch: result.set.branch,
                            version: result.set.version,
                            key: result.set.key,
                            kind: result.set.kind,
                            files: result.set.fileCount,
                            bytes: result.set.bytes,
                            created: result.created,
                        },
                    };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/sets",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ project: string; branch: string }>();
                    const key = await mintKey(getBoardsDb(), body.project, slugifyBranch(body.branch));
                    return { kind: "json", status: 200, body: { key } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/projects",
            handler: async () => {
                const projects = await listProjects(getBoardsDb());
                return { kind: "json", status: 200, body: { projects } };
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/sets/:project",
            handler: async (ctx) => {
                const sets = await listSets(getBoardsDb(), ctx.params.project);
                return { kind: "json", status: 200, body: { sets } };
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/sets/:project/:branch",
            handler: async (ctx) => {
                const sets = await listSets(getBoardsDb(), ctx.params.project, ctx.params.branch);
                return { kind: "json", status: 200, body: { sets } };
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/sets/:project/:branch/:selector",
            handler: async (ctx) => {
                try {
                    const detail = await getSet(
                        getBoardsDb(),
                        ctx.params.project,
                        ctx.params.branch,
                        ctx.params.selector
                    );
                    return {
                        kind: "json",
                        status: 200,
                        body: { ...detail, files: detail.files.map((f) => ({ ...f, url: blobUrl(f.blobKey) })) },
                    };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "PATCH",
            pattern: "/api/boards/sets/:project/:branch/:selector",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ name?: string; title?: string }>();
                    const updated = await patchSet(
                        getBoardsDb(),
                        ctx.params.project,
                        ctx.params.branch,
                        ctx.params.selector,
                        body
                    );
                    return { kind: "json", status: 200, body: updated };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/blobs/:key",
            handler: async (ctx) => {
                const path = blobPath(ctx.params.key);
                if (!path) {
                    return { kind: "json", status: 404, body: { error: "blob not found" } };
                }
                const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
                return {
                    kind: "binary",
                    status: 200,
                    body: bytes,
                    contentType: mimeForPath(ctx.params.key),
                    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
                };
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/operator",
            handler: async () => ({ kind: "json", status: 200, body: { operator: await getOperator() } }),
        },
        {
            method: "PUT",
            pattern: "/api/boards/operator",
            handler: async (ctx) => {
                const body = await ctx.readJson<{ operator: string }>();
                await setOperator(body.operator);
                return { kind: "json", status: 200, body: { operator: body.operator } };
            },
        },
    ];
}
