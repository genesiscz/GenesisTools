export type { VaultEntry } from "@app/utils/obsidian/vault-tree";

export interface RenderedNote {
    source: string;
    html: string;
    publishedSlug: string | null;
}
