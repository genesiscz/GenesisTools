import { normalizeVaultPath } from "@genesiscz/utils/obsidian/paths";

export function buildObsidianNoteHref(notePath: string): string {
    return `/obsidian?note=${encodeURIComponent(normalizeVaultPath(notePath))}`;
}
