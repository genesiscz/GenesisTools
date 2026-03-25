export function stripPartSuffixes(name: string): string {
    return name.replace(/\s*\(part\s+\d+\)/g, "").trim();
}

export function formatChunkDisplayName(
    name: string | undefined,
    startLine: number,
    endLine: number,
    kind?: string,
): string {
    const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
    const cleanName = name ? stripPartSuffixes(name) : "";

    if (cleanName) {
        return `${cleanName}:${lineRange}`;
    }

    if (kind) {
        return `${kind}:${lineRange}`;
    }

    return `L${lineRange}`;
}
