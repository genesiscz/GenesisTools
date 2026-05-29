export interface VaultEntry {
    name: string;
    relativePath: string;
    isDirectory: boolean;
    children?: VaultEntry[];
}
