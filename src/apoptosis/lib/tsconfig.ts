import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { AliasConfig } from "./types";

interface TsconfigShape {
    compilerOptions?: {
        baseUrl?: string;
        paths?: Record<string, string[]>;
    };
}

function readTsconfig(path: string): AliasConfig | null {
    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8")) as TsconfigShape;
        const paths = parsed.compilerOptions?.paths;
        if (!paths || Object.keys(paths).length === 0) {
            return null;
        }

        // `paths` resolve against baseUrl; when absent, TS anchors them at the
        // tsconfig's own directory.
        const baseDir = resolve(dirname(path), parsed.compilerOptions?.baseUrl ?? ".");
        return { baseDir, paths };
    } catch (error) {
        logger.debug(`apoptosis: could not read tsconfig at ${path}: ${error}`);
        return null;
    }
}

/**
 * Walk up from `startDir` to the filesystem root, returning the first
 * `tsconfig.json` that declares `compilerOptions.paths`. Only inline paths are
 * read (an `extends`-ed base is not followed — documented as a limitation).
 * Returns null when no aliased tsconfig is found.
 */
export function loadAliasConfig(startDir: string): AliasConfig | null {
    let dir = resolve(startDir);
    for (;;) {
        const candidate = join(dir, "tsconfig.json");
        if (existsSync(candidate)) {
            const config = readTsconfig(candidate);
            if (config) {
                logger.debug(`apoptosis: loaded ${Object.keys(config.paths).length} path aliases from ${candidate}`);
                return config;
            }
        }

        const parent = dirname(dir);
        if (parent === dir) {
            return null;
        }

        dir = parent;
    }
}
