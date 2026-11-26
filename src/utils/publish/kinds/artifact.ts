import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { isSnapshotId } from "../ids";
import { definePublishedKind, serveKind } from "../kind";
import { SNAPSHOT_MANIFEST, type SnapshotManifestBase } from "../snapshot-store";

export const ARTIFACT_ENTRY = "index.html";
export const ARTIFACT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export interface ArtifactManifest extends SnapshotManifestBase {
    version: 1;
    id: string;
    sourceName: string;
}

export const ArtifactManifestSchema: z.ZodType<ArtifactManifest> = z.object({
    version: z.literal(1),
    id: z.string().refine(isSnapshotId),
    title: z.string(),
    snapshotAt: z.iso.datetime(),
    sourceModifiedAt: z.string().optional(),
    sourceName: z.string(),
});

function parseManifest(bytes: Uint8Array): ArtifactManifest | null {
    try {
        return (
            ArtifactManifestSchema.safeParse(SafeJSON.parse(new TextDecoder().decode(bytes), { strict: true })).data ??
            null
        );
    } catch (err) {
        logger.debug({ err }, "artifact manifest is not JSON");
        return null;
    }
}

export const artifactKind = definePublishedKind({
    id: "artifact",
    title: "Artifact",
    maxUploadBytes: ARTIFACT_MAX_UPLOAD_BYTES,
    isEntryName: (name) => name === SNAPSHOT_MANIFEST || name === ARTIFACT_ENTRY,
    checkSnapshot: ({ id, files }) => {
        const bytes = files.get(SNAPSHOT_MANIFEST);
        const manifest = bytes && parseManifest(bytes);
        if (!manifest || manifest.id !== id) {
            return { ok: false, error: "invalid artifact manifest or id" };
        }

        if (files.size !== 2 || !files.has(ARTIFACT_ENTRY)) {
            return { ok: false, error: "artifact snapshot must contain manifest.json and index.html" };
        }

        return { ok: true };
    },
});

export const artifactKindServer = serveKind(artifactKind, async ({ url, id, rest, kindDir }) => {
    if (rest !== "" || !isSnapshotId(id)) {
        return null;
    }

    const dir = join(kindDir, id);
    const manifestFile = Bun.file(join(dir, SNAPSHOT_MANIFEST));
    const html = Bun.file(join(dir, ARTIFACT_ENTRY));
    if (!(await manifestFile.exists()) || !(await html.exists())) {
        return null;
    }

    const manifest = parseManifest(await manifestFile.bytes());
    if (!manifest || manifest.id !== id) {
        return null;
    }

    const headers = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Last-Modified": new Date(manifest.snapshotAt).toUTCString(),
    });

    if (url.searchParams.get("download") === "1") {
        const title = manifest.title.trim().replaceAll(/[/\\]/g, "-") || "artifact";
        const name = encodeURIComponent(`${title.toWellFormed()}.html`).replaceAll(
            /['()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
        );
        headers.set("Content-Disposition", `attachment; filename*=UTF-8''${name}`);
    }

    return new Response(html, { headers });
});

export async function writeArtifactSnapshot(input: {
    dir: string;
    id: string;
    title: string;
    html: Uint8Array;
    sourceName: string;
    sourceModifiedAt?: string;
}): Promise<void> {
    const { dir, id, title, html, sourceName, sourceModifiedAt } = input;
    const manifest: ArtifactManifest = {
        version: 1,
        id,
        title,
        sourceName,
        snapshotAt: new Date().toISOString(),
        sourceModifiedAt,
    };
    await Bun.write(join(dir, ARTIFACT_ENTRY), html);
    await Bun.write(join(dir, SNAPSHOT_MANIFEST), SafeJSON.stringify(manifest, null, 2));
}
