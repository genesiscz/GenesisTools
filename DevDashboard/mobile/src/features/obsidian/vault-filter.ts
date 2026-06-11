import type { VaultEntry } from "@dd/contract";

/**
 * Pure vault-tree filter, mirroring the web `filterEntries` in the dashboard's `ObsidianTree`:
 * case-insensitive; keep a directory when its name matches OR it has matching descendants, and return
 * it with the FILTERED `children` in both cases. A folder-name-only match therefore yields
 * `children: []` (the matched folder shows with no visible leaves). This is intentionally identical
 * to the web — the brief is parity, so do NOT "improve" it to keep all original children.
 */
export function filterVaultEntries(entries: VaultEntry[], rawQuery: string): VaultEntry[] {
    const query = rawQuery.trim().toLowerCase();

    if (!query) {
        return entries;
    }

    return entries.flatMap((entry) => {
        if (entry.isDirectory) {
            const children = filterVaultEntries(entry.children ?? [], query);

            if (children.length > 0 || entry.name.toLowerCase().includes(query)) {
                return [{ ...entry, children }];
            }

            return [];
        }

        return entry.name.toLowerCase().includes(query) ? [entry] : [];
    });
}
