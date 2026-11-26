import { SHARE_BUNDLE_MAX_BYTES } from "@app/dev-dashboard/lib/obsidian/share-assets";
import {
    isSnapshotEntryName,
    ShareSnapshotManifestSchema,
    snapshotAssetFile,
} from "@app/dev-dashboard/lib/share/snapshot";
import { SafeJSON } from "@genesiscz/utils/json";
import { definePublishedKind, type PublishedKind } from "@genesiscz/utils/publish/kind";
import { SNAPSHOT_MANIFEST } from "@genesiscz/utils/publish/snapshot-store";

export const MAX_SNAPSHOT_UPLOAD_BYTES = SHARE_BUNDLE_MAX_BYTES + 16 * 1024 * 1024;

export const mdKind: PublishedKind = definePublishedKind({
    id: "md",
    title: "Shared note",
    maxUploadBytes: MAX_SNAPSHOT_UPLOAD_BYTES,
    isEntryName: isSnapshotEntryName,
    checkSnapshot: ({ id, files }) => {
        const bytes = files.get(SNAPSHOT_MANIFEST);
        if (!bytes) {
            return { ok: false, error: "snapshot has no manifest" };
        }

        const parsed = ShareSnapshotManifestSchema.safeParse(
            SafeJSON.parse(new TextDecoder().decode(bytes), { strict: true })
        );
        if (!parsed.success) {
            return { ok: false, error: "manifest does not match the note snapshot schema" };
        }

        const manifest = parsed.data;
        if (manifest.slug !== id) {
            return { ok: false, error: "manifest names another slug" };
        }

        if (manifest.assets.list.some((asset) => asset.file !== snapshotAssetFile(asset))) {
            return { ok: false, error: "snapshot asset path does not match its hash and extension" };
        }

        const missing = [manifest.noteFile, ...manifest.assets.list.map((asset) => asset.file)].find(
            (name) => !files.has(name)
        );
        if (missing !== undefined) {
            return { ok: false, error: `snapshot lacks ${missing}` };
        }

        return { ok: true };
    },
});
