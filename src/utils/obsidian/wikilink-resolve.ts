import { normalizeVaultPath } from "@app/utils/obsidian/paths";
import type { VaultEntry } from "@app/utils/obsidian/vault-tree";

export function wikilinkTargetKey(target: string): string {
    return normalizeVaultPath(target.trim()).replace(/\.md$/i, "");
}

export function resolveWikilinkToVaultPath(entries: VaultEntry[], target: string, fromPath?: string): string | null {
    const key = wikilinkTargetKey(target);
    const matches: string[] = [];

    function walk(items: VaultEntry[]): void {
        for (const item of items) {
            if (item.isDirectory) {
                walk(item.children ?? []);
                continue;
            }

            const relNoExt = item.relativePath.replace(/\.md$/i, "");
            const base = item.name.replace(/\.md$/i, "");

            if (base === key || relNoExt === key || relNoExt.endsWith(`/${key}`)) {
                matches.push(item.relativePath);
            }
        }
    }

    walk(entries);

    if (matches.length === 0) {
        return null;
    }

    if (matches.length === 1) {
        return matches[0];
    }

    if (fromPath) {
        const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
        const sameDir = matches.filter((match) => {
            const dir = match.includes("/") ? match.slice(0, match.lastIndexOf("/")) : "";

            return dir === fromDir;
        });

        if (sameDir.length >= 1) {
            return sameDir[0];
        }
    }

    return matches.sort((a, b) => a.length - b.length)[0];
}
