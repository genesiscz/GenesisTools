export interface VaultEntry {
    name: string;
    relativePath: string;
    isDirectory: boolean;
    children?: VaultEntry[];
}

export interface RenderedNote {
    source: string;
    html: string;
    publishedSlug: string | null;
}
