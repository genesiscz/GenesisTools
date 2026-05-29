export function normalizeVaultPath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\/+/, "");
}
