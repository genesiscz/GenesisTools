import { sep } from "node:path";
import { matchGlob } from "@app/utils/string";

/** Match `rel` against `pattern` as the full relpath OR any path segment.
 *  Splits on the platform path separator (`/` on POSIX, `\` on Windows). */
export function pathOrSegmentMatches(rel: string, pattern: string): boolean {
    if (matchGlob(rel, pattern)) {
        return true;
    }

    for (const seg of rel.split(sep)) {
        if (matchGlob(seg, pattern)) {
            return true;
        }
    }

    return false;
}

/** Returns true iff `rel` (or any of its path segments, or — when `base`
 *  is supplied — its basename) is NOT in any exclude AND (no include OR
 *  matches one). Exclude wins over include. */
export function passesGlobs(rel: string, include?: string[], exclude?: string[], base?: string): boolean {
    const matches = (g: string): boolean => {
        if (pathOrSegmentMatches(rel, g)) {
            return true;
        }

        return base !== undefined && matchGlob(base, g);
    };

    if (exclude?.some(matches)) {
        return false;
    }

    if (include && include.length > 0) {
        return include.some(matches);
    }

    return true;
}
