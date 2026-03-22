import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface PathAliases {
    /** Map of alias prefix -> target directories (relative to project root) */
    entries: Map<string, string[]>;
}

const EMPTY_ALIASES: PathAliases = { entries: new Map() };
const MAX_EXTENDS_DEPTH = 10;

/**
 * Load path aliases from tsconfig.json or jsconfig.json.
 * Follows `extends` chains to find `compilerOptions.paths`.
 * Returns empty aliases if no config found (graceful degradation).
 */
export function loadPathAliases(baseDir: string): PathAliases {
    const configNames = ["tsconfig.json", "jsconfig.json"];

    for (const name of configNames) {
        const configPath = join(baseDir, name);

        try {
            const raw = readFileSync(configPath, "utf-8");
            const aliases = parsePathAliases(raw, baseDir);

            if (aliases.entries.size > 0) {
                return aliases;
            }

            // No paths in this file -- follow extends chain
            const extended = followExtendsChain(configPath, baseDir);

            if (extended.entries.size > 0) {
                return extended;
            }
        } catch {
            // File not found -- try next config name
        }
    }

    return EMPTY_ALIASES;
}

/** Strip JSON comments (// and /* *\/) that tsconfig allows */
function stripJsonComments(json: string): string {
    return json.replace(
        /"(?:[^"\\]|\\.)*"|\/\/.*$|\/\*[\s\S]*?\*\//gm,
        (match) => (match.startsWith('"') ? match : ""),
    );
}

/** Parse tsconfig JSON with comment stripping. Returns null on failure. */
function parseTsconfigJson(content: string): Record<string, unknown> | null {
    try {
        return JSON.parse(stripJsonComments(content));
    } catch {
        return null;
    }
}

/** Parse path aliases from tsconfig/jsconfig JSON content. */
export function parsePathAliases(jsonContent: string, projectDir: string): PathAliases {
    const config = parseTsconfigJson(jsonContent);

    if (!config) {
        return EMPTY_ALIASES;
    }

    const compilerOptions = config.compilerOptions as Record<string, unknown> | undefined;

    if (!compilerOptions?.paths) {
        return EMPTY_ALIASES;
    }

    const baseUrl = (compilerOptions.baseUrl as string) ?? ".";
    const baseDir = resolve(projectDir, baseUrl);
    const paths = compilerOptions.paths as Record<string, string[]>;
    const entries = new Map<string, string[]>();

    for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) {
            continue;
        }

        // "$lib/*" -> prefix "$lib/", exact "~" -> prefix "~"
        const prefix = pattern.endsWith("/*") ? pattern.slice(0, -1) : pattern;
        const resolvedTargets: string[] = [];

        for (const target of targets) {
            if (typeof target !== "string") {
                continue;
            }

            const targetPath = target.endsWith("/*") ? target.slice(0, -1) : target;
            const absolute = resolve(baseDir, targetPath);
            resolvedTargets.push(relative(projectDir, absolute));
        }

        if (resolvedTargets.length > 0) {
            entries.set(prefix, resolvedTargets);
        }
    }

    return { entries };
}

/** Follow the `extends` chain looking for `compilerOptions.paths`. */
function followExtendsChain(configPath: string, projectDir: string): PathAliases {
    const visited = new Set<string>();
    let currentPath = configPath;

    for (let depth = 0; depth < MAX_EXTENDS_DEPTH; depth++) {
        const resolved = resolve(currentPath);

        if (visited.has(resolved)) {
            break;
        }

        visited.add(resolved);

        let raw: string;

        try {
            raw = readFileSync(resolved, "utf-8");
        } catch {
            break;
        }

        const config = parseTsconfigJson(raw);

        if (!config) {
            break;
        }

        const co = config.compilerOptions as Record<string, unknown> | undefined;

        if (co?.paths) {
            return parsePathAliases(raw, dirname(resolved));
        }

        const extendsValue = config.extends;

        if (!extendsValue || typeof extendsValue !== "string") {
            break;
        }

        const configDir = dirname(resolved);

        if (extendsValue.startsWith(".")) {
            currentPath = resolve(configDir, extendsValue);

            if (!currentPath.endsWith(".json")) {
                currentPath += ".json";
            }
        } else {
            // Package reference -- resolve from node_modules
            currentPath = resolve(configDir, "node_modules", extendsValue);

            if (!currentPath.endsWith(".json")) {
                currentPath += ".json";
            }
        }
    }

    return EMPTY_ALIASES;
}
