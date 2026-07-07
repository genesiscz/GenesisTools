import type { DatabaseClient } from "@app/utils/database/client";
import { SafeJSON } from "@app/utils/json";
import { type Selectable, sql } from "kysely";
import { mimeForPath, putBlob } from "./blobs";
import type { BoardsDb, SetsTable } from "./db-types";
import { readImageDims } from "./image-size";
import type { TarEntry } from "./tar";
import { nowIso } from "./time";
import type { SetDetailDto, SetFileDto, SetSummaryDto } from "./types";

export const KEY_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export class NameConflictError extends Error {}
export class NotFoundError extends Error {}

export function slugifyBranch(raw: string): string {
    return (
        raw
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64) || "main"
    );
}

/** Reject keys/names that collide with the version-selector grammar. */
export function isReservedKey(key: string): boolean {
    return /^\d+$/.test(key) || key === "latest" || key.endsWith(".zip");
}

export interface SyncSetInput {
    project: string;
    branchRaw: string;
    key: string;
    kind?: string;
    title?: string;
    commitSha?: string;
    repo?: string;
    sourceRef?: string;
    entries: TarEntry[]; // includes manifest.json when present
}

export interface SyncSetResult {
    set: SetSummaryDto;
    created: boolean;
}

interface ManifestShot {
    file: string;
    [key: string]: unknown;
}

interface ManifestJson {
    journey?: Record<string, unknown>;
    shots?: ManifestShot[];
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function parseManifest(entries: TarEntry[]): ManifestJson | null {
    const manifestEntry = entries.find((e) => e.path === "manifest.json");
    if (!manifestEntry) {
        return null;
    }
    try {
        const text = new TextDecoder().decode(manifestEntry.data);
        return SafeJSON.parse(text, { strict: true }) as ManifestJson;
    } catch {
        // Corrupted/absent manifest: ingest files without meta rather than failing the push.
        return null;
    }
}

function toSummaryDto(row: Selectable<SetsTable>): SetSummaryDto {
    return {
        id: row.id,
        project: row.project,
        branch: row.branch_slug,
        version: row.version,
        key: row.key,
        kind: row.kind,
        title: row.title,
        name: row.name,
        sourceRef: row.source_ref,
        fileCount: row.file_count,
        bytes: row.bytes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

async function resolveSetRow(
    db: DatabaseClient<BoardsDb>,
    project: string,
    branch: string,
    selector: string
): Promise<Selectable<SetsTable> | undefined> {
    const base = db.kysely
        .selectFrom("sets")
        .selectAll()
        .where("project", "=", project)
        .where("branch_slug", "=", branch);

    if (/^\d+$/.test(selector)) {
        return base.where("version", "=", Number(selector)).executeTakeFirst();
    }
    if (selector === "latest") {
        return base.orderBy("version", "desc").executeTakeFirst();
    }
    const byName = await base.where("name", "=", selector).executeTakeFirst();
    if (byName) {
        return byName;
    }
    return base.where("key", "=", selector).executeTakeFirst();
}

/** Upsert a set by (project, branch, key): first push mints version = 1+MAX(version)
 *  per (project,branch) inside the tx; re-push of the same key keeps its version and
 *  replaces ALL file rows. manifest.json (if present among entries) supplies per-file
 *  meta: { journey?: {...}, shots?: [{ file, route?, label?, title?, note?, action?, ts? }] }.
 *  Blobs are written (content-addressed) BEFORE the tx; file rows reference blob keys. */
export async function syncSet(db: DatabaseClient<BoardsDb>, input: SyncSetInput): Promise<SyncSetResult> {
    const branchSlug = slugifyBranch(input.branchRaw);
    const manifest = parseManifest(input.entries);
    const shotsByFile = new Map<string, Record<string, unknown>>();
    for (const shot of manifest?.shots ?? []) {
        const { file, ...rest } = shot;
        shotsByFile.set(file, rest);
    }

    const fileEntries = input.entries.filter((e) => e.path !== "manifest.json");
    const prepared: Array<{
        path: string;
        mime: string;
        bytes: number;
        blobKey: string;
        width: number;
        height: number;
        meta: string;
    }> = [];
    for (const entry of fileEntries) {
        const mime = mimeForPath(entry.path);
        const dims = mime.startsWith("image/") ? readImageDims(entry.data) : null;
        const blobKey = await putBlob(entry.data, mime);
        prepared.push({
            path: entry.path,
            mime,
            bytes: entry.data.length,
            blobKey,
            width: dims?.width ?? 0,
            height: dims?.height ?? 0,
            meta: SafeJSON.stringify(shotsByFile.get(entry.path) ?? {}),
        });
    }

    const totalBytes = prepared.reduce((sum, f) => sum + f.bytes, 0);
    const journeyJson = manifest?.journey ? SafeJSON.stringify(manifest.journey) : "";
    const now = nowIso();

    return db.kysely.transaction().execute(async (trx) => {
        const existing = await trx
            .selectFrom("sets")
            .selectAll()
            .where("project", "=", input.project)
            .where("branch_slug", "=", branchSlug)
            .where("key", "=", input.key)
            .executeTakeFirst();

        let setId: number;
        let created: boolean;

        if (existing) {
            setId = existing.id;
            created = false;
            await trx
                .updateTable("sets")
                .set({
                    title: input.title ?? existing.title,
                    commit_sha: input.commitSha ?? existing.commit_sha,
                    repo: input.repo ?? existing.repo,
                    source_ref: input.sourceRef ?? existing.source_ref,
                    journey: journeyJson || existing.journey,
                    file_count: prepared.length,
                    bytes: totalBytes,
                    updated_at: now,
                })
                .where("id", "=", setId)
                .execute();
        } else {
            const maxVersionRow = await trx
                .selectFrom("sets")
                .select(({ fn }) => fn.max("version").as("maxVersion"))
                .where("project", "=", input.project)
                .where("branch_slug", "=", branchSlug)
                .executeTakeFirst();
            const version = Number(maxVersionRow?.maxVersion ?? 0) + 1;
            const inserted = await trx
                .insertInto("sets")
                .values({
                    project: input.project,
                    branch_slug: branchSlug,
                    branch_raw: input.branchRaw,
                    version,
                    key: input.key,
                    kind: input.kind ?? "screenshots",
                    title: input.title ?? "",
                    commit_sha: input.commitSha ?? "",
                    repo: input.repo ?? "",
                    source_ref: input.sourceRef ?? "",
                    name: "",
                    journey: journeyJson,
                    file_count: prepared.length,
                    bytes: totalBytes,
                    created_at: now,
                    updated_at: now,
                })
                .returning("id")
                .executeTakeFirstOrThrow();
            setId = inserted.id;
            created = true;
        }

        await trx.deleteFrom("set_files").where("set_id", "=", setId).execute();
        if (prepared.length > 0) {
            await trx
                .insertInto("set_files")
                .values(
                    prepared.map((f) => ({
                        set_id: setId,
                        path: f.path,
                        mime: f.mime,
                        bytes: f.bytes,
                        blob_key: f.blobKey,
                        width: f.width,
                        height: f.height,
                        meta: f.meta,
                    }))
                )
                .execute();
        }

        const finalRow = await trx.selectFrom("sets").selectAll().where("id", "=", setId).executeTakeFirstOrThrow();
        return { set: toSummaryDto(finalRow), created };
    });
}

export async function listProjects(
    db: DatabaseClient<BoardsDb>
): Promise<Array<{ project: string; branches: number; sets: number; updatedAt: string }>> {
    const rows = await db.kysely
        .selectFrom("sets")
        .select((eb) => [
            "project",
            sql<number>`COUNT(DISTINCT branch_slug)`.as("branches"),
            eb.fn.countAll<number>().as("sets"),
            eb.fn.max<string>("updated_at").as("updatedAt"),
        ])
        .groupBy("project")
        .orderBy("project", "asc")
        .execute();

    return rows.map((r) => ({
        project: r.project,
        branches: Number(r.branches),
        sets: Number(r.sets),
        updatedAt: r.updatedAt ?? "",
    }));
}

/** newest first */
export async function listSets(
    db: DatabaseClient<BoardsDb>,
    project: string,
    branch?: string
): Promise<SetSummaryDto[]> {
    let q = db.kysely.selectFrom("sets").selectAll().where("project", "=", project);
    if (branch) {
        q = q.where("branch_slug", "=", branch);
    }
    const rows = await q.orderBy("updated_at", "desc").execute();
    return rows.map(toSummaryDto);
}

/** selector: decimal version | "latest" | name | key (that priority). */
export async function getSet(
    db: DatabaseClient<BoardsDb>,
    project: string,
    branch: string,
    selector: string
): Promise<SetDetailDto> {
    const row = await resolveSetRow(db, project, branch, selector);
    if (!row) {
        throw new NotFoundError(`set not found: ${project}/${branch}/${selector}`);
    }

    const fileRows = await db.kysely
        .selectFrom("set_files")
        .selectAll()
        .where("set_id", "=", row.id)
        .orderBy("path", "asc")
        .execute();

    const files: SetFileDto[] = fileRows.map((f) => ({
        path: f.path,
        mime: f.mime,
        bytes: f.bytes,
        blobKey: f.blob_key,
        width: f.width,
        height: f.height,
        meta: SafeJSON.parse(f.meta || "{}", { strict: true }) as Record<string, unknown>,
    }));

    return { ...toSummaryDto(row), files };
}

// NameConflictError, isReservedKey names rejected
export async function patchSet(
    db: DatabaseClient<BoardsDb>,
    project: string,
    branch: string,
    selector: string,
    patch: { name?: string; title?: string }
): Promise<SetSummaryDto> {
    const row = await resolveSetRow(db, project, branch, selector);
    if (!row) {
        throw new NotFoundError(`set not found: ${project}/${branch}/${selector}`);
    }

    let name = row.name;
    if (patch.name !== undefined) {
        const candidate = patch.name.toLowerCase();
        if (!KEY_RE.test(candidate) || isReservedKey(candidate)) {
            throw new NameConflictError(`invalid set name: ${patch.name}`);
        }
        const conflict = await db.kysely
            .selectFrom("sets")
            .select("id")
            .where("project", "=", project)
            .where("branch_slug", "=", branch)
            .where("id", "!=", row.id)
            .where((eb) => eb.or([eb("name", "=", candidate), eb("key", "=", candidate)]))
            .executeTakeFirst();
        if (conflict) {
            throw new NameConflictError(`set name already in use: ${candidate}`);
        }
        name = candidate;
    }

    const updated = await db.kysely
        .updateTable("sets")
        .set({ name, title: patch.title ?? row.title, updated_at: nowIso() })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();

    return toSummaryDto(updated);
}

/** `s-YYYYMMDD-HHMM` + `-2`,`-3`… on collision. */
export async function mintKey(db: DatabaseClient<BoardsDb>, project: string, branch: string): Promise<string> {
    const now = new Date();
    const stamp =
        `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
        `-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;

    for (let suffix = 0; ; suffix += 1) {
        const candidate = suffix === 0 ? `s-${stamp}` : `s-${stamp}-${suffix + 1}`;
        const clash = await db.kysely
            .selectFrom("sets")
            .select("id")
            .where("project", "=", project)
            .where("branch_slug", "=", branch)
            .where("key", "=", candidate)
            .executeTakeFirst();
        if (!clash) {
            return candidate;
        }
    }
}

export async function getSetFile(
    db: DatabaseClient<BoardsDb>,
    setId: number,
    path: string
): Promise<SetFileDto | null> {
    const row = await db.kysely
        .selectFrom("set_files")
        .selectAll()
        .where("set_id", "=", setId)
        .where("path", "=", path)
        .executeTakeFirst();
    if (!row) {
        return null;
    }
    return {
        path: row.path,
        mime: row.mime,
        bytes: row.bytes,
        blobKey: row.blob_key,
        width: row.width,
        height: row.height,
        meta: SafeJSON.parse(row.meta || "{}", { strict: true }) as Record<string, unknown>,
    };
}

export function setRefOf(s: { project: string; branch: string; key: string }): string {
    return `${s.project}/${s.branch}/${s.key}`;
}
