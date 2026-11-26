import { getConfig } from "@app/dev-dashboard/config";
import { findPublishedBySlug, listPublished } from "@app/dev-dashboard/lib/obsidian/publish";
import { readNote } from "@app/dev-dashboard/lib/obsidian/reader";
import {
    buildShareAssetIndex,
    hashAsset,
    type ShareAssetIndex,
    vaultAssetReader,
} from "@app/dev-dashboard/lib/obsidian/share-assets";
import { publicBaseUrl } from "@app/dev-dashboard/lib/public-base";
import { type ShareSource, ShareSourceUnavailableError } from "@app/dev-dashboard/lib/share/source";
import { redactSecretsInText } from "@genesiscz/utils/transclude";

const ASSET_CACHE_LIMIT = 64;
const ASSET_INDEX_TTL_MS = 30_000;

/**
 * Keyed by slug; an entry is reused only while the note's text hashes the same and for at most
 * `ASSET_INDEX_TTL_MS`: an edited or newly added attachment gets its new hash URL on the next page
 * load after that, never only after a 404 on the old URL.
 */
const assetIndexCache = new Map<string, { sourceHash: string; builtAt: number; index: ShareAssetIndex }>();

async function vaultRoot(): Promise<string> {
    const { obsidianVault } = await getConfig();

    if (!obsidianVault) {
        throw new ShareSourceUnavailableError("obsidian vault not configured");
    }

    return obsidianVault;
}

/** The Obsidian vault on this Mac, read live at each request. */
export function vaultShareSource(): ShareSource {
    return {
        findBySlug: async (slug) => (await findPublishedBySlug(slug)) ?? null,
        listPublished,
        readNoteText: async (note) => redactSecretsInText(await readNote(await vaultRoot(), note.vaultPath)),
        assetIndex: async ({ note, markdown }) => {
            const root = await vaultRoot();
            const sourceHash = hashAsset(new TextEncoder().encode(`${note.vaultPath}\n${markdown}`));
            const cached = assetIndexCache.get(note.slug);

            if (cached?.sourceHash === sourceHash && Date.now() - cached.builtAt < ASSET_INDEX_TTL_MS) {
                return cached.index;
            }

            const index = await buildShareAssetIndex({ vaultRoot: root, notePath: note.vaultPath, source: markdown });

            assetIndexCache.delete(note.slug);
            assetIndexCache.set(note.slug, { sourceHash, builtAt: Date.now(), index });

            if (assetIndexCache.size > ASSET_CACHE_LIMIT) {
                const oldest = assetIndexCache.keys().next().value;

                if (oldest !== undefined) {
                    assetIndexCache.delete(oldest);
                }
            }

            return index;
        },
        forgetAssetIndex: (slug) => {
            assetIndexCache.delete(slug);
        },
        assetReader: async () => vaultAssetReader(await vaultRoot()),
        publicOrigin: publicBaseUrl,
    };
}
