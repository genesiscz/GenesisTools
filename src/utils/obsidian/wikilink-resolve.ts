import { normalizeVaultPath } from "@genesiscz/utils/obsidian/paths";
import type { VaultEntry } from "@genesiscz/utils/obsidian/vault-tree";

export function wikilinkTargetKey(target: string): string {
    return normalizeVaultPath(target.trim()).replace(/\.md$/i, "");
}

/**
 * The vault path a wikilink `target` names, as the disk spells it, or null. An exact spelling wins; only when no name
 * matches as written are the names compared in NFC. macOS keeps a file name's accents decomposed (NFD) while a link
 * typed in a note is composed, and both name the same file there; a file system that keeps both spellings as two
 * files still opens the one the link spells.
 */
export function resolveWikilinkToVaultPath(entries: VaultEntry[], target: string, fromPath?: string): string | null {
    const key = wikilinkTargetKey(target);
    const exact = matchingPaths(entries, key, (name) => name);
    const matches =
        exact.length > 0 ? exact : matchingPaths(entries, key.normalize("NFC"), (name) => name.normalize("NFC"));

    if (matches.length === 0) {
        return null;
    }

    if (matches.length === 1) {
        return matches[0];
    }

    if (fromPath) {
        const dirOf = (path: string) =>
            (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "").normalize("NFC");
        const fromDir = dirOf(fromPath);
        const sameDir = matches.filter((match) => dirOf(match) === fromDir);

        if (sameDir.length >= 1) {
            return sameDir[0];
        }
    }

    return matches.sort((a, b) => a.length - b.length)[0];
}

/** Every file whose name or vault path, spelled by `spell`, ends in `key` (`.md` dropped from both sides). */
function matchingPaths(entries: VaultEntry[], key: string, spell: (name: string) => string): string[] {
    const matches: string[] = [];

    function walk(items: VaultEntry[]): void {
        for (const item of items) {
            if (item.isDirectory) {
                walk(item.children ?? []);
                continue;
            }

            const relNoExt = spell(item.relativePath).replace(/\.md$/i, "");
            const base = spell(item.name).replace(/\.md$/i, "");

            if (base === key || relNoExt === key || relNoExt.endsWith(`/${key}`)) {
                matches.push(item.relativePath);
            }
        }
    }

    walk(entries);

    return matches;
}
