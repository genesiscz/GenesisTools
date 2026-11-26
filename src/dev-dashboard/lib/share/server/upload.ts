import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SHARE_BUNDLE_MAX_BYTES } from "@app/dev-dashboard/lib/obsidian/share-assets";
import {
    isSnapshotEntryName,
    type ShareSnapshotManifest,
    ShareSnapshotManifestSchema,
    SNAPSHOT_MANIFEST,
} from "@app/dev-dashboard/lib/share/snapshot";
import { SHARE_SLUG_RE } from "@app/dev-dashboard/lib/share/source";
import { unzip } from "@genesiscz/utils/fs/unzip";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("share-upload");

/** A whole snapshot, as the zip a paired Mac uploads: the page's own size limit plus room for the note and manifest. */
export const MAX_SNAPSHOT_UPLOAD_BYTES = SHARE_BUNDLE_MAX_BYTES + 16 * 1024 * 1024;

export type UploadOutcome =
    | { ok: true; manifest: ShareSnapshotManifest }
    | { ok: false; status: number; error: string };

function refuse(status: number, error: string): UploadOutcome {
    return { ok: false, status, error };
}

function scratchName(kind: "incoming" | "old", slug: string): string {
    return `.${kind}-${slug}-${randomBytes(4).toString("hex")}`;
}

/**
 * Check an uploaded snapshot zip and put it in place of `<dataDir>/<slug>`. Only the names a snapshot holds are
 * accepted (`isSnapshotEntryName`, so no path can leave the folder), the manifest must parse and name this slug, and
 * every file it lists must be in the zip. The new folder is renamed into place, so a reader never sees half of it.
 */
export async function installSnapshotUpload(options: {
    dataDir: string;
    slug: string;
    body: Uint8Array;
}): Promise<UploadOutcome> {
    const { dataDir, slug, body } = options;

    if (!SHARE_SLUG_RE.test(slug)) {
        return refuse(400, "bad slug");
    }

    let files: Map<string, Uint8Array>;

    try {
        files = unzip(body, { maxTotalBytes: MAX_SNAPSHOT_UPLOAD_BYTES });
    } catch (err) {
        log.warn({ err, slug }, "share upload is not a readable zip");
        return refuse(400, "not a readable snapshot zip");
    }

    const stray = [...files.keys()].find((name) => !isSnapshotEntryName(name));

    if (stray !== undefined) {
        return refuse(400, `unexpected file in snapshot: ${stray.slice(0, 80)}`);
    }

    const manifestBytes = files.get(SNAPSHOT_MANIFEST);

    if (!manifestBytes) {
        return refuse(400, "snapshot has no manifest");
    }

    let raw: unknown;

    try {
        raw = SafeJSON.parse(new TextDecoder().decode(manifestBytes), { strict: true });
    } catch (err) {
        log.warn({ err, slug }, "share upload manifest is not JSON");
        return refuse(400, "manifest is not JSON");
    }

    const parsed = ShareSnapshotManifestSchema.safeParse(raw);

    if (!parsed.success) {
        return refuse(400, "manifest does not match the snapshot schema");
    }

    const manifest = parsed.data;

    if (manifest.slug !== slug) {
        return refuse(400, "manifest names another slug");
    }

    const missing = [manifest.noteFile, ...manifest.assets.list.map((asset) => asset.file)].find(
        (name) => !files.has(name)
    );

    if (missing !== undefined) {
        return refuse(400, `snapshot lacks ${missing}`);
    }

    await mkdir(dataDir, { recursive: true });
    const incoming = join(dataDir, scratchName("incoming", slug));
    await mkdir(join(incoming, "assets"), { recursive: true, mode: 0o755 });

    try {
        for (const [name, data] of files) {
            await writeFile(join(incoming, name), data, { mode: 0o644 });
        }

        await swapIn({ dataDir, slug, incoming });
    } finally {
        await rm(incoming, { recursive: true, force: true });
    }

    log.info({ slug, files: files.size }, "share snapshot installed");

    return { ok: true, manifest };
}

async function swapIn(options: { dataDir: string; slug: string; incoming: string }): Promise<void> {
    const { dataDir, slug, incoming } = options;
    const target = join(dataDir, slug);
    const old = join(dataDir, scratchName("old", slug));
    const existing = await stat(target).catch(() => null);

    if (existing) {
        await rename(target, old);
    }

    await rename(incoming, target);

    if (existing) {
        await rm(old, { recursive: true, force: true });
    }
}

/** Remove `<dataDir>/<slug>`; false when there was none. */
export async function removeSnapshot(options: { dataDir: string; slug: string }): Promise<boolean> {
    const { dataDir, slug } = options;

    if (!SHARE_SLUG_RE.test(slug)) {
        return false;
    }

    const target = join(dataDir, slug);

    if (!(await stat(target).catch(() => null))) {
        return false;
    }

    const old = join(dataDir, scratchName("old", slug));
    await rename(target, old);
    await rm(old, { recursive: true, force: true });
    log.info({ slug }, "share snapshot removed");

    return true;
}

export async function listSnapshotSlugs(dataDir: string): Promise<string[]> {
    const names = await readdir(dataDir).catch(() => [] as string[]);
    const slugs: string[] = [];

    for (const name of names) {
        if (SHARE_SLUG_RE.test(name) && (await stat(join(dataDir, name, SNAPSHOT_MANIFEST)).catch(() => null))) {
            slugs.push(name);
        }
    }

    return slugs.sort();
}
