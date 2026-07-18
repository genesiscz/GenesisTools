export type { VaultEntry } from "@genesiscz/utils/obsidian/vault-tree";

export interface RenderedNote {
    source: string;
    html: string;
    publishedSlug: string | null;
}
