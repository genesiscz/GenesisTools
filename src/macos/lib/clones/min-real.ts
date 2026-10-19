const UNITS: Record<string, number> = {
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

/** How a size flag's help and error name the accepted forms. */
export const BYTE_SIZE_FORMS = "a number with a unit: 512B, 100KB, 10MB, 1GB";

/** A size flag (`--min-real`, `--min-size`, `--max-bytes`): "512B", "100KB", "10 MB", "1.5GB". The unit is
 *  required, so a bare "102400" is refused instead of being guessed as bytes (Martin, 2026-10-19). Units are
 *  binary, as `formatBytes` prints them. `Number.parseInt` alone accepts `-1` and `12abc`; a negative floor
 *  disables the native walk and turns the advertised large-file scan into a walk and hash of every file under
 *  every root. Returns null for anything that is not a positive size with a unit. */
export function parseByteSize(raw: string): number | null {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(raw);
    if (match === null) {
        return null;
    }

    const unit = UNITS[match[2].toLowerCase()];
    if (unit === undefined || (unit === 1 && match[1].includes("."))) {
        return null;
    }

    const value = Math.floor(Number(match[1]) * unit);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A count flag (`--max-files`, `--min-real-kilobytes`): a positive whole number, no unit. */
export function parseCount(raw: string): number | null {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) {
        return null;
    }

    const value = Number(text);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** `--min-real <size>` and its three unit-named aliases, as commander hands them over. */
export interface MinRealFlags {
    minReal?: string;
    minRealBytes?: string;
    minRealKilobytes?: string;
    minRealMegabytes?: string;
}

export type MinRealResolution = { bytes: number | undefined } | { error: string };

/** The one size the four flags name, or `fallback` when none is given. More than one flag is an error, so an
 *  alias can never silently lose to the other. */
export function resolveMinReal(flags: MinRealFlags, fallback: number | undefined): MinRealResolution {
    const given: Array<{ flag: string; raw: string; bytes: number | null; forms: string }> = [];
    const count = (raw: string, scale: number): number | null => {
        const n = parseCount(raw);
        return n === null ? null : n * scale;
    };

    if (flags.minReal !== undefined) {
        given.push({
            flag: "--min-real",
            raw: flags.minReal,
            bytes: parseByteSize(flags.minReal),
            forms: BYTE_SIZE_FORMS,
        });
    }

    if (flags.minRealBytes !== undefined) {
        given.push({
            flag: "--min-real-bytes",
            raw: flags.minRealBytes,
            bytes: count(flags.minRealBytes, 1),
            forms: "a whole number",
        });
    }

    if (flags.minRealKilobytes !== undefined) {
        given.push({
            flag: "--min-real-kilobytes",
            raw: flags.minRealKilobytes,
            bytes: count(flags.minRealKilobytes, 1024),
            forms: "a whole number",
        });
    }

    if (flags.minRealMegabytes !== undefined) {
        given.push({
            flag: "--min-real-megabytes",
            raw: flags.minRealMegabytes,
            bytes: count(flags.minRealMegabytes, 1024 ** 2),
            forms: "a whole number",
        });
    }

    if (given.length > 1) {
        return { error: `Pass one of ${given.map((g) => g.flag).join(", ")}, not several.` };
    }

    const only = given[0];
    if (only === undefined) {
        return { bytes: fallback };
    }

    if (only.bytes === null || !Number.isSafeInteger(only.bytes)) {
        return { error: `${only.flag} must be a positive size (${only.forms}), got "${only.raw}".` };
    }

    return { bytes: only.bytes };
}
