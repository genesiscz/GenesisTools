import type { PublishedNote } from "@app/dev-dashboard/config";
import type { ShareAssetIndex, ShareAssetReader } from "@app/dev-dashboard/lib/obsidian/share-assets";

/**
 * Every read the public share page makes. The Mac reads the Obsidian vault live (`vaultShareSource`), the share
 * server reads the snapshots the Mac sent it (`snapshotShareSource`); the route and its renderer are the same for both.
 */
export interface ShareSource {
    findBySlug(slug: string): Promise<PublishedNote | null>;
    /** Every published note this source can serve, so links between shared notes resolve. */
    listPublished(): Promise<PublishedNote[]>;
    /** The note's text with its secrets masked: the page, its source view and its downloads all show this text. */
    readNoteText(note: PublishedNote): Promise<string>;
    /** The assets `markdown` references; `markdown` is the note text as the page renders it. */
    assetIndex(options: { note: PublishedNote; markdown: string }): Promise<ShareAssetIndex>;
    /** Forget a cached index, because one of its assets no longer reads under its hash. */
    forgetAssetIndex(slug: string): void;
    assetReader(note: PublishedNote): Promise<ShareAssetReader>;
    /** The origin a saved (offline) copy of the page links other shared notes to: `https://host`, no path. */
    publicOrigin(): Promise<string>;
}

/** The source cannot serve any page (no vault configured). Its message is safe to show on the public page. */
export class ShareSourceUnavailableError extends Error {}

/** The page title of a shared note: its file name without `.md`. */
export function shareTitle(vaultPath: string): string {
    return (vaultPath.split("/").pop() ?? vaultPath).replace(/\.md$/, "");
}

/** A slug as `publishNote` makes it (base64url), so it is always one safe path segment. */
export const SHARE_SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
