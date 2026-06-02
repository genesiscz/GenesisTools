import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

interface IstanbulFileEntry {
    lines?: { covered?: number };
}

/**
 * Load a json (istanbul-shape) coverage file into a set of absolute paths that
 * have >0 covered lines. Returns an empty set when no path is given or the file
 * cannot be read/parsed.
 */
export function loadCoverageSet(coveragePath: string | undefined): Set<string> {
    const set = new Set<string>();
    if (!coveragePath) {
        return set;
    }

    let raw: string;
    try {
        raw = readFileSync(coveragePath, "utf8");
    } catch (error) {
        logger.warn(`apoptosis: could not read coverage file ${coveragePath}: ${error}`);
        return set;
    }

    let parsed: Record<string, IstanbulFileEntry>;
    try {
        parsed = SafeJSON.parse(raw) as Record<string, IstanbulFileEntry>;
    } catch (error) {
        logger.warn(`apoptosis: could not parse coverage file ${coveragePath}: ${error}`);
        return set;
    }

    const baseDir = resolve(coveragePath, "..");
    for (const [key, entry] of Object.entries(parsed)) {
        if ((entry.lines?.covered ?? 0) > 0) {
            set.add(isAbsolute(key) ? key : resolve(baseDir, key));
        }
    }

    return set;
}
