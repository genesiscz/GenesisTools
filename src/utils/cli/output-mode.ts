const STRUCTURED_FORMATS = new Set(["json", "toon"]);

export function isQuietOutput(format?: string): boolean {
    if (!process.stdout.isTTY) {
        return true;
    }

    return format !== undefined && STRUCTURED_FORMATS.has(format);
}
