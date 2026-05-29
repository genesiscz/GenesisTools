import { normalizeVaultPath } from "@app/utils/obsidian/paths";

export type ObsidianSearch = {
    note?: string;
    open?: string;
};

export { normalizeVaultPath };

export function parseObsidianSearch(search: Record<string, unknown>): ObsidianSearch {
    const note = typeof search.note === "string" && search.note.trim() ? normalizeVaultPath(search.note) : undefined;
    const open = typeof search.open === "string" && search.open.trim() ? search.open : undefined;

    return { note, open };
}
