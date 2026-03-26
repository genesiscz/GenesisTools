export function stripPartSuffixes(name: string): string {
    return name.replace(/\s*\(part\s+\d+\)\s*$/i, "").trim();
}

export function formatChunkDisplayName(
    name: string | undefined,
    startLine: number | undefined,
    endLine: number | undefined,
    kind?: string
): string {
    const cleanName = name ? stripPartSuffixes(name) : "";
    const hasLines = startLine != null && endLine != null && !Number.isNaN(startLine) && !Number.isNaN(endLine);

    if (!hasLines) {
        return cleanName || kind || "chunk";
    }

    const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

    if (cleanName) {
        return `${cleanName}:${lineRange}`;
    }

    if (kind) {
        return `${kind}:${lineRange}`;
    }

    return `L${lineRange}`;
}
