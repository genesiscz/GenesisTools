import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { PublishedNote } from "@app/dev-dashboard/config";
import {
    codeLanguageFor,
    fencedCode,
    SHARE_ASSET_HASH_RE,
    SHARE_ASSET_MAX_BYTES,
    type ShareAsset,
    type ShareAssetIndex,
} from "@app/dev-dashboard/lib/obsidian/share-assets";
import { SHARE_SLUG_RE, type ShareSource, shareTitle } from "@app/dev-dashboard/lib/share/source";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { SNAPSHOT_MANIFEST } from "@genesiscz/utils/publish/snapshot-store";
import { z } from "zod";

const { log } = logger.scoped("share-snapshot");

export const SHARE_SNAPSHOT_VERSION = 1;
export { SNAPSHOT_MANIFEST };

const SHARE_ASSET_KINDS = [
    "image",
    "audio",
    "video",
    "pdf",
    "json",
    "markdown",
    "code",
] as const satisfies readonly ShareAsset["kind"][];
const EXT_RE = /^\.[a-z0-9]{1,10}$/;
const NOTE_FILE_RE = /^note(\.[a-z0-9]{1,10})?$/;
const ASSET_FILE_RE = /^assets\/[0-9a-f]{64}(\.[a-z0-9]{1,10})?$/;

const SnapshotAssetSchema = z.object({
    hash: z.string().regex(SHARE_ASSET_HASH_RE),
    /** The asset's real path on the Mac: its identity (`isSharedNote`, `linkedNoteKey`). The server never reads it. */
    absPath: z.string(),
    vaultPath: z.string(),
    name: z.string(),
    kind: z.enum(SHARE_ASSET_KINDS),
    contentType: z.string(),
    language: z.string().optional(),
    file: z.string().regex(ASSET_FILE_RE),
});

const AssetRefsSchema = z.record(z.string(), z.number().int().min(0));

/** One shared note as the share server holds it: `<data>/<slug>/manifest.json` beside the note text and its assets. */
export const ShareSnapshotManifestSchema = z.object({
    version: z.literal(SHARE_SNAPSHOT_VERSION),
    slug: z.string().regex(SHARE_SLUG_RE),
    title: z.string(),
    vaultPath: z.string(),
    publishedAt: z.string(),
    snapshotAt: z.string(),
    /** The note file's mtime when the snapshot was taken. Optional, so a server older than this field still reads it. */
    sourceModifiedAt: z.string().optional(),
    noteFile: z.string().regex(NOTE_FILE_RE),
    /** Published notes this note links to, when the snapshot was taken. */
    links: z.array(z.object({ slug: z.string().regex(SHARE_SLUG_RE), vaultPath: z.string() })),
    assets: z.object({
        sharedNote: z.string(),
        list: z.array(SnapshotAssetSchema),
        /** Indexes into `list`, so one asset keeps one identity in every map, as in `ShareAssetIndex`. */
        byTarget: AssetRefsSchema,
        byHash: AssetRefsSchema,
        linkedImages: z.record(z.string(), AssetRefsSchema),
    }),
});

export type ShareSnapshotManifest = z.infer<typeof ShareSnapshotManifestSchema>;

function extOf(path: string): string {
    const ext = posix.extname(path).toLowerCase();

    return EXT_RE.test(ext) ? ext : "";
}

/** Where the snapshot keeps an asset's served body: by hash, so two links to the same bytes share one file. */
export function snapshotAssetFile(asset: Pick<ShareAsset, "hash" | "vaultPath">): string {
    return `assets/${asset.hash}${extOf(asset.vaultPath)}`;
}

/** True for the only names a snapshot folder may hold; an upload with any other name is refused. */
export function isSnapshotEntryName(name: string): boolean {
    return name === SNAPSHOT_MANIFEST || NOTE_FILE_RE.test(name) || ASSET_FILE_RE.test(name);
}

function serializeIndex(index: ShareAssetIndex, keep: (asset: ShareAsset) => boolean): ShareSnapshotManifest["assets"] {
    const list: ShareSnapshotManifest["assets"]["list"] = [];
    const ids = new Map<ShareAsset, number>();
    const idOf = (asset: ShareAsset): number => {
        const known = ids.get(asset);

        if (known !== undefined) {
            return known;
        }

        list.push({ ...asset, file: snapshotAssetFile(asset) });
        ids.set(asset, list.length - 1);

        return list.length - 1;
    };
    const refs = (map: Map<string, ShareAsset>): Record<string, number> =>
        Object.fromEntries([...map].filter(([, asset]) => keep(asset)).map(([key, asset]) => [key, idOf(asset)]));

    return {
        sharedNote: index.sharedNote,
        byTarget: refs(index.byTarget),
        byHash: refs(index.byHash),
        linkedImages: Object.fromEntries([...index.linkedImages].map(([key, images]) => [key, refs(images)])),
        list,
    };
}

export function deserializeIndex(assets: ShareSnapshotManifest["assets"]): ShareAssetIndex {
    const list: ShareAsset[] = assets.list.map(({ file: _file, ...asset }) => asset);
    const map = (refs: Record<string, number>): Map<string, ShareAsset> => {
        const out = new Map<string, ShareAsset>();

        for (const [key, id] of Object.entries(refs)) {
            const asset = list[id];

            if (asset) {
                out.set(key, asset);
            }
        }

        return out;
    };

    return {
        sharedNote: assets.sharedNote,
        byTarget: map(assets.byTarget),
        byHash: map(assets.byHash),
        linkedImages: new Map(Object.entries(assets.linkedImages).map(([key, refs]) => [key, map(refs)])),
    };
}

function allAssets(index: ShareAssetIndex): ShareAsset[] {
    const images = [...index.linkedImages.values()].flatMap((map) => [...map.values()]);

    return [...new Set([...index.byTarget.values(), ...index.byHash.values(), ...images])];
}

/**
 * Write one shared note into `dir` as the share server serves it: the masked note text, the masked body of every
 * asset the page can serve (`assets/<hash><ext>`) and the manifest. An asset that no longer reads is left out.
 */
export async function writeShareSnapshot(options: {
    source: ShareSource;
    note: PublishedNote;
    dir: string;
}): Promise<ShareSnapshotManifest> {
    const { source, note, dir } = options;
    const text = await source.readNoteText(note);
    const language = codeLanguageFor(note.vaultPath);
    const markdown = language ? fencedCode(text, language) : text;
    const index = await source.assetIndex({ note, markdown });
    const read = await source.assetReader(note);
    const written = new Set<string>();
    const missing = new Set<ShareAsset>();

    await mkdir(join(dir, "assets"), { recursive: true });

    for (const asset of allAssets(index)) {
        const file = snapshotAssetFile(asset);

        if (written.has(file)) {
            continue;
        }

        const body = await read(asset);

        if (!body) {
            missing.add(asset);
            continue;
        }

        await writeFile(join(dir, file), body);
        written.add(file);
    }

    const published = await source.listPublished();
    const linkedPaths = new Set([...index.byTarget.values()].map((asset) => asset.vaultPath.normalize("NFC")));
    const noteFile = `note${extOf(note.vaultPath)}`;
    const manifest: ShareSnapshotManifest = {
        version: SHARE_SNAPSHOT_VERSION,
        slug: note.slug,
        title: shareTitle(note.vaultPath),
        vaultPath: note.vaultPath,
        publishedAt: note.publishedAt,
        snapshotAt: new Date().toISOString(),
        sourceModifiedAt: (await source.freshness(note)).editedAt,
        noteFile,
        links: published
            .filter((other) => other.slug !== note.slug && linkedPaths.has(other.vaultPath.normalize("NFC")))
            .map(({ slug, vaultPath }) => ({ slug, vaultPath })),
        assets: serializeIndex(index, (asset) => !missing.has(asset)),
    };

    await writeFile(join(dir, noteFile), text);
    await writeFile(join(dir, SNAPSHOT_MANIFEST), SafeJSON.stringify(manifest, null, 2));
    log.debug({ slug: note.slug, assets: written.size, missing: missing.size }, "share snapshot written");

    return manifest;
}

/** Parse a manifest, or null when it is missing or not a manifest this version reads. */
export async function readSnapshotManifest(dir: string): Promise<ShareSnapshotManifest | null> {
    try {
        const raw = await readFile(join(dir, SNAPSHOT_MANIFEST), "utf8");
        const parsed = ShareSnapshotManifestSchema.safeParse(SafeJSON.parse(raw, { strict: true }));

        if (!parsed.success) {
            log.warn({ dir, issues: parsed.error.issues }, "share snapshot manifest does not parse");
            return null;
        }

        return parsed.data;
    } catch (err) {
        log.debug({ dir, err }, "share snapshot manifest is not readable");
        return null;
    }
}

/** A published note as the snapshot records it. */
function noteOf(manifest: ShareSnapshotManifest): PublishedNote {
    return {
        slug: manifest.slug,
        vaultPath: manifest.vaultPath,
        publishedAt: manifest.publishedAt,
    };
}

/**
 * The share server's source: `<dataDir>/<slug>/` folders written by `writeShareSnapshot`. A folder is read again
 * when its manifest changes, so a new upload shows at the next request.
 */
export function snapshotShareSource(options: { dataDir: string; publicOrigin: string }): ShareSource {
    const { dataDir, publicOrigin } = options;
    const cache = new Map<string, { mtimeMs: number; manifest: ShareSnapshotManifest }>();

    const load = async (slug: string): Promise<ShareSnapshotManifest | null> => {
        if (!SHARE_SLUG_RE.test(slug)) {
            return null;
        }

        const dir = join(dataDir, slug);
        const info = await stat(join(dir, SNAPSHOT_MANIFEST)).catch(() => null);

        if (!info) {
            cache.delete(slug);
            return null;
        }

        const cached = cache.get(slug);

        if (cached?.mtimeMs === info.mtimeMs) {
            return cached.manifest;
        }

        const manifest = await readSnapshotManifest(dir);

        if (!manifest || manifest.slug !== slug) {
            return null;
        }

        cache.set(slug, { mtimeMs: info.mtimeMs, manifest });

        return manifest;
    };

    const loadOrThrow = async (slug: string): Promise<ShareSnapshotManifest> => {
        const manifest = await load(slug);

        if (!manifest) {
            throw new Error(`no snapshot for ${slug}`);
        }

        return manifest;
    };

    return {
        findBySlug: async (slug) => {
            const manifest = await load(slug);

            return manifest ? noteOf(manifest) : null;
        },
        listPublished: async () => {
            const names = await readdir(dataDir).catch(() => [] as string[]);
            const notes: PublishedNote[] = [];

            for (const name of names) {
                const manifest = await load(name);

                if (manifest) {
                    notes.push(noteOf(manifest));
                }
            }

            return notes;
        },
        readNoteText: async (note) => {
            const manifest = await loadOrThrow(note.slug);

            return readFile(join(dataDir, note.slug, manifest.noteFile), "utf8");
        },
        assetIndex: async ({ note }) => deserializeIndex((await loadOrThrow(note.slug)).assets),
        // A snapshot changes only by a new upload, which the manifest's mtime already catches.
        forgetAssetIndex: () => {},
        assetReader: async (note) => async (asset) => {
            const path = join(dataDir, note.slug, snapshotAssetFile(asset));
            const info = await stat(path).catch(() => null);

            if (!info?.isFile() || info.size > SHARE_ASSET_MAX_BYTES) {
                return null;
            }

            return readFile(path);
        },
        freshness: async (note) => {
            const manifest = await loadOrThrow(note.slug);

            return { mode: "snapshot", syncedAt: manifest.snapshotAt, editedAt: manifest.sourceModifiedAt };
        },
        publicOrigin: async () => publicOrigin,
    };
}
