import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isMissingPathError } from "@genesiscz/utils/fs/canonical";
import { freeDiskSpace } from "@genesiscz/utils/fs/disk-usage";
import { unzip } from "@genesiscz/utils/fs/unzip";
import { zipAsync } from "@genesiscz/utils/fs/zip";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { z } from "zod";
import { isSnapshotId, KIND_ID_RE } from "./ids";
import type { PublishedKind, SnapshotCheck } from "./kind";

const { log } = logger.scoped("publish-snapshots");

export const SNAPSHOT_MANIFEST = "manifest.json";
export const MAX_SNAPSHOT_FILES = 5000;

export interface SnapshotManifestBase {
    title: string;
    snapshotAt: string;
    sourceModifiedAt?: string;
}

export const SnapshotManifestBaseSchema: z.ZodType<SnapshotManifestBase> = z.looseObject({
    title: z.string(),
    snapshotAt: z.string(),
    sourceModifiedAt: z.string().optional(),
});

export type InstallOutcome = { ok: true; title: string } | { ok: false; status: number; error: string };

export function isSafeEntryName(name: string): boolean {
    return (
        name.length <= 300 &&
        !name.includes("\0") &&
        !name.includes("\\") &&
        !name.includes(":") &&
        name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !/[ .]$/.test(part))
    );
}

async function missingAsNull<T>(operation: Promise<T>): Promise<T | null> {
    try {
        return await operation;
    } catch (err) {
        if (!isMissingPathError(err)) {
            throw err;
        }

        return null;
    }
}

function validLocation(kind: string, id: string): boolean {
    return KIND_ID_RE.test(kind) && isSnapshotId(id);
}

function validateSnapshot(
    kind: PublishedKind,
    id: string,
    files: ReadonlyMap<string, Uint8Array>
): { ok: true; manifest: SnapshotManifestBase } | { ok: false; error: string } {
    if (files.size > MAX_SNAPSHOT_FILES) {
        return { ok: false, error: "too many files in snapshot" };
    }

    for (const name of files.keys()) {
        if (!isSafeEntryName(name) || !kind.isEntryName(name)) {
            return { ok: false, error: `unexpected file in snapshot: ${name.slice(0, 80)}` };
        }
    }

    const bytes = files.get(SNAPSHOT_MANIFEST);
    if (!bytes) {
        return { ok: false, error: "snapshot has no manifest" };
    }

    try {
        const manifest = SnapshotManifestBaseSchema.safeParse(
            SafeJSON.parse(new TextDecoder().decode(bytes), { strict: true })
        );

        if (!manifest.success) {
            return { ok: false, error: "manifest does not match the snapshot schema" };
        }

        const check = kind.checkSnapshot({ id, files });
        return check.ok ? { ok: true, manifest: manifest.data } : check;
    } catch (err) {
        log.debug({ err, id, kind: kind.id }, "snapshot validation failed");
        return { ok: false, error: "snapshot manifest is invalid" };
    }
}

async function availableBytes(dir: string): Promise<number> {
    let path = resolve(dir);

    while (!(await missingAsNull(lstat(path)))) {
        path = dirname(path);
    }

    return freeDiskSpace(path).available;
}

export async function installSnapshot(input: {
    dataDir: string;
    kind: PublishedKind;
    id: string;
    body: Uint8Array;
    minFreeBytes: number;
}): Promise<InstallOutcome> {
    const { dataDir, kind, id, body, minFreeBytes } = input;

    if (!validLocation(kind.id, id)) {
        return { ok: false, status: 400, error: "bad snapshot id or kind" };
    }

    if (body.byteLength > kind.maxUploadBytes) {
        return { ok: false, status: 413, error: "snapshot zip is too large" };
    }

    let files: Map<string, Uint8Array>;
    try {
        files = unzip(body, { maxTotalBytes: kind.maxUploadBytes });
    } catch (err) {
        log.warn({ err, kind: kind.id, id }, "snapshot upload is not a readable zip");
        return { ok: false, status: 400, error: "not a readable snapshot zip" };
    }

    const check = validateSnapshot(kind, id, files);
    if (!check.ok) {
        return { ...check, status: 400 };
    }

    const size = [...files.values()].reduce((sum, entry) => sum + entry.byteLength, 0);
    if ((await availableBytes(dataDir)) < minFreeBytes + size) {
        return { ok: false, status: 507, error: "insufficient free disk space" };
    }

    const kindDir = join(dataDir, kind.id);
    await mkdir(kindDir, { recursive: true });
    const incoming = await mkdtemp(join(kindDir, ".incoming-"));
    try {
        for (const [name, data] of files) {
            const path = join(incoming, name);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, data, { mode: 0o644 });
        }

        await withFileLock(join(kindDir, `.${id}.lock`), () => swapIn(kindDir, id, incoming));
    } finally {
        await rm(incoming, { recursive: true, force: true });
    }

    log.info({ kind: kind.id, id, files: files.size }, "snapshot installed");
    return { ok: true, title: check.manifest.title };
}

async function swapIn(kindDir: string, id: string, incoming: string): Promise<void> {
    const target = join(kindDir, id);
    if (!(await missingAsNull(lstat(target)))) {
        await rename(incoming, target);
        return;
    }

    const backup = await mkdtemp(join(kindDir, ".old-"));
    const old = join(backup, id);
    await rename(target, old);
    try {
        await rename(incoming, target);
    } catch (err) {
        await rename(old, target);
        await rm(backup, { recursive: true, force: true });
        throw err;
    }

    await rm(backup, { recursive: true, force: true });
}

export async function removeSnapshot(input: { dataDir: string; kind: string; id: string }): Promise<boolean> {
    const { dataDir, kind, id } = input;
    if (!validLocation(kind, id)) {
        return false;
    }

    const dir = join(dataDir, kind);
    if (!(await missingAsNull(lstat(dir)))) {
        return false;
    }

    return withFileLock(join(dir, `.${id}.lock`), async () => {
        const target = join(dir, id);
        if (!(await missingAsNull(lstat(target)))) {
            return false;
        }

        const removed = await mkdtemp(join(dir, ".removed-"));
        await rename(target, join(removed, id));
        await rm(removed, { recursive: true, force: true });
        log.info({ kind, id }, "snapshot removed");
        return true;
    });
}

export async function readSnapshotManifestBase(input: {
    dataDir: string;
    kind: string;
    id: string;
}): Promise<SnapshotManifestBase | null> {
    if (!validLocation(input.kind, input.id)) {
        return null;
    }

    const file = join(input.dataDir, input.kind, input.id, SNAPSHOT_MANIFEST);
    const raw = await missingAsNull(readFile(file, "utf8"));
    if (raw === null) {
        return null;
    }

    try {
        return SnapshotManifestBaseSchema.safeParse(SafeJSON.parse(raw, { strict: true })).data ?? null;
    } catch (err) {
        log.debug({ err, file }, "snapshot manifest is not JSON");
        return null;
    }
}

export async function listSnapshotIds(input: { dataDir: string; kind: string }): Promise<string[]> {
    if (!KIND_ID_RE.test(input.kind)) {
        return [];
    }

    const dir = join(input.dataDir, input.kind);
    const entries = await missingAsNull(readdir(dir, { withFileTypes: true }));
    const ids: string[] = [];
    for (const entry of entries ?? []) {
        if (
            entry.isDirectory() &&
            isSnapshotId(entry.name) &&
            (await missingAsNull(lstat(join(dir, entry.name, SNAPSHOT_MANIFEST))))?.isFile()
        ) {
            ids.push(entry.name);
        }
    }

    return ids.sort();
}

async function snapshotFiles(dir: string, kind?: PublishedKind): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    const folders = [""];
    let size = 0;
    for (const folder of folders) {
        const entries = await readdir(join(dir, folder), { withFileTypes: true });
        for (const entry of entries) {
            const name = folder ? `${folder}/${entry.name}` : entry.name;

            if (!isSafeEntryName(name)) {
                throw new Error(`unexpected file in snapshot: ${name}`);
            }

            if (entry.isDirectory()) {
                folders.push(name);
                continue;
            }

            if (!entry.isFile() || (kind && !kind.isEntryName(name))) {
                throw new Error(`unexpected file in snapshot: ${name}`);
            }

            if (files.size >= MAX_SNAPSHOT_FILES) {
                throw new Error("too many files in snapshot");
            }

            const file = Bun.file(join(dir, name));
            if (kind && size + file.size > kind.maxUploadBytes) {
                throw new Error("snapshot files are too large");
            }

            const data = await file.bytes();
            size += data.byteLength;
            if (kind && size > kind.maxUploadBytes) {
                throw new Error("snapshot files are too large");
            }

            files.set(name, data);
        }
    }

    return files;
}

export async function checkSnapshotDir(input: {
    kind: PublishedKind;
    id: string;
    dir: string;
}): Promise<SnapshotCheck> {
    if (!validLocation(input.kind.id, input.id)) {
        return { ok: false, error: "bad snapshot id or kind" };
    }

    try {
        const check = validateSnapshot(input.kind, input.id, await snapshotFiles(input.dir, input.kind));
        return check.ok ? { ok: true } : check;
    } catch (err) {
        log.debug({ err, dir: input.dir }, "failed to check snapshot directory");
        return { ok: false, error: err instanceof Error ? err.message : "cannot read snapshot directory" };
    }
}

export async function packSnapshot(dir: string): Promise<Uint8Array> {
    const files = await snapshotFiles(dir);
    return zipAsync(Array.from(files, ([name, data]) => ({ name, data })));
}

export async function migrateFlatDataDir(input: {
    dataDir: string;
    kind: string;
    kindIds: readonly string[];
}): Promise<string[]> {
    const { dataDir, kind, kindIds } = input;
    if (!KIND_ID_RE.test(kind)) {
        throw new Error(`Invalid published kind id: ${kind}`);
    }

    const moved: string[] = [];
    const entries = await missingAsNull(readdir(dataDir, { withFileTypes: true }));
    for (const entry of entries ?? []) {
        const id = entry.name;
        if (!entry.isDirectory() || !isSnapshotId(id) || id === kind || kindIds.includes(id)) {
            continue;
        }

        const from = join(dataDir, id);
        if (!(await missingAsNull(lstat(join(from, SNAPSHOT_MANIFEST))))?.isFile()) {
            continue;
        }

        const kindDir = join(dataDir, kind);
        const to = join(kindDir, id);
        if (await missingAsNull(lstat(to))) {
            log.warn({ from, to }, "skipped legacy snapshot because the destination exists");
            continue;
        }

        await mkdir(kindDir, { recursive: true });
        await rename(from, to);
        moved.push(id);
        log.info({ kind, id }, "moved legacy snapshot into kind folder");
    }

    return moved.sort();
}
