export interface ChecksumEntry {
    hex: string;
    path: string;
}

export interface VerifyResult {
    path: string;
    ok: boolean;
    unreadable?: boolean;
}

export interface VerifySummary {
    total: number;
    failed: number;
}

export function formatChecksumLine(hex: string, path: string): string {
    return `${hex}  ${path}`;
}

export function parseChecksumFile(text: string): ChecksumEntry[] {
    const entries: ChecksumEntry[] = [];

    for (const rawLine of text.split("\n")) {
        const line = rawLine.trimEnd();
        if (line.length === 0 || line.startsWith("#")) {
            continue;
        }

        const match = line.match(/^([0-9a-fA-F]+)\s+\*?(.+)$/);
        if (!match) {
            continue;
        }

        entries.push({ hex: match[1].toLowerCase(), path: match[2] });
    }

    return entries;
}

export function summarizeVerify(results: VerifyResult[]): VerifySummary {
    const failed = results.filter((r) => !r.ok).length;
    return { total: results.length, failed };
}
