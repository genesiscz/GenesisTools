import type { VaultEntry } from "./vault-tree";

/**
 * Case-insensitive vault-tree filter shared by the dev-dashboard web tree and
 * the phone. A directory stays when it matches or a descendant matches, and
 * the returned node carries the filtered children — a folder-name-only match
 * therefore has `children: []`.
 *
 * A query containing `/` is a path and also matches `relativePath`, so
 * `folder/note.md` finds that note. A name-only query does not match through
 * the path: `acme` would otherwise show every file under Acme.
 */
export function filterVaultEntries(entries: VaultEntry[], rawQuery: string): VaultEntry[] {
    const query = rawQuery.trim().toLowerCase();

    if (!query) {
        return entries;
    }

    return filterNormalized(entries, query);
}

function filterNormalized(entries: VaultEntry[], query: string): VaultEntry[] {
    return entries.flatMap((entry) => {
        if (entry.isDirectory) {
            const children = filterNormalized(entry.children ?? [], query);

            if (children.length > 0 || entryMatches(entry, query)) {
                return [{ ...entry, children }];
            }

            return [];
        }

        return entryMatches(entry, query) ? [entry] : [];
    });
}

function entryMatches(entry: VaultEntry, query: string): boolean {
    if (entry.name.toLowerCase().includes(query)) {
        return true;
    }

    if (!query.includes("/")) {
        return false;
    }

    return entry.relativePath.toLowerCase().includes(query);
}
