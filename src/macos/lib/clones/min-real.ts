const UNITS: Record<string, number> = {
    "": 1,
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
};

/** A size flag (`--min-real`, `--min-size`, `--max-bytes`): "102400", "100KB", "10 MB", "1.5GB". Units are
 *  binary, as `formatBytes` prints them, and a fraction needs a unit. `Number.parseInt` alone accepts `-1` and
 *  `12abc`; a negative floor disables the native walk and turns the advertised large-file scan into a walk and
 *  hash of every file under every root. Returns null for anything that is not a positive size. */
export function parseByteSize(raw: string): number | null {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(raw);
    if (match === null) {
        return null;
    }

    const unit = UNITS[(match[2] ?? "").toLowerCase()];
    if (unit === undefined || (unit === 1 && match[1].includes("."))) {
        return null;
    }

    const value = Math.floor(Number(match[1]) * unit);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A count flag (`--max-files`): a positive whole number, no unit. */
export function parseCount(raw: string): number | null {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) {
        return null;
    }

    const value = Number(text);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** How a size flag's help and error name the accepted forms. */
export const BYTE_SIZE_FORMS = "bytes, or with a unit: 100KB, 10MB, 1GB";
