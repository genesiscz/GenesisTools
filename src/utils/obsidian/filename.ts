export function normalizeObsidianBaseName(input: string): string {
    return input.trim().replace(/\.md$/i, "");
}

export function obsidianNoteFileName(baseName: string): string {
    const base = normalizeObsidianBaseName(baseName);

    if (!base) {
        return "";
    }

    return `${base}.md`;
}

export function buildObsidianNoteRelativePath(dir: string, baseName: string): string | null {
    const fileName = obsidianNoteFileName(baseName);

    if (!fileName) {
        return null;
    }

    return `${dir}/${fileName}`;
}
