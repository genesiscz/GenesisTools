const PATTERNS: RegExp[] = [
    /\bimport\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[^"';]*?\s+)?from\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function parseImports(content: string): string[] {
    const specs = new Set<string>();
    for (const pattern of PATTERNS) {
        pattern.lastIndex = 0;
        let match = pattern.exec(content);
        while (match !== null) {
            specs.add(match[1]);
            match = pattern.exec(content);
        }
    }

    return [...specs];
}
