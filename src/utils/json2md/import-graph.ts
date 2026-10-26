import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** The loader `Bun.Transpiler` needs for a module path, or null for a file that carries no imports. */
function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" | null {
    const match = /\.([cm]?)([jt]sx?)$/.exec(path);

    if (!match) {
        return null;
    }

    return match[2] === "ts" || match[2] === "tsx" || match[2] === "jsx" ? match[2] : "js";
}

/** A module graph bigger than this is not a document; stop there rather than walk a whole repo. */
const MAX_SCANNED_MODULES = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first string target of a package.json `imports` value, conditions in Bun's order. */
function importTarget(value: unknown): string | null {
    if (typeof value === "string") {
        return value;
    }

    if (!isRecord(value)) {
        return null;
    }

    for (const condition of ["bun", "import", "default", "node", "require"]) {
        const target = importTarget(value[condition]);

        if (target) {
            return target;
        }
    }

    return null;
}

/**
 * What a `#` specifier maps to in the nearest package.json `imports` field: an absolute path for a
 * local target, the bare name for a package target, or null when nothing maps it. Read from the
 * manifest, never through the resolver, so a package target is never looked up or installed.
 */
function mappedImport(specifier: string, fromDir: string): string | null {
    let dir = resolve(fromDir);

    while (!existsSync(join(dir, "package.json"))) {
        const parent = dirname(dir);

        if (parent === dir) {
            return null;
        }

        dir = parent;
    }

    let imports: unknown;

    try {
        imports = (SafeJSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { imports?: unknown }).imports;
    } catch (error) {
        logger.debug({ error, dir }, "import-graph: package.json did not parse; a # import is not followed");
        return null;
    }

    if (!isRecord(imports)) {
        return null;
    }

    for (const [key, value] of Object.entries(imports)) {
        let target = importTarget(value);

        if (!target) {
            continue;
        }

        if (key.includes("*")) {
            const [prefix, suffix] = key.split("*");

            if (
                !specifier.startsWith(prefix) ||
                !specifier.endsWith(suffix) ||
                specifier.length < prefix.length + suffix.length
            ) {
                continue;
            }

            target = target.replaceAll("*", specifier.slice(prefix.length, specifier.length - suffix.length));
        } else if (key !== specifier) {
            continue;
        }

        return target.startsWith(".") ? resolve(dir, target) : target;
    }

    return null;
}

/**
 * The folder of every module in `entry`'s local import graph that imports one of `packages` (a bare name such as
 * `@genesiscz/utils`, matched with or without a subpath).
 * Each is where the package must resolve from: a helper in a linked project serves a document
 * that sits anywhere. Local means a relative or absolute specifier, or a `#` import that the
 * nearest package.json maps to a local file; every bare specifier is a leaf, so this never asks
 * the resolver about a package and never reaches Bun's auto-installer. A module that cannot be
 * parsed falls back to a text search for the package name.
 */
export async function importerDirsOf(entry: string, packages: readonly string[]): Promise<string[]> {
    const importers = new Set<string>();
    const seen = new Set<string>();
    const queue = [resolve(entry)];

    while (queue.length > 0 && seen.size < MAX_SCANNED_MODULES) {
        const file = queue.shift();

        if (file === undefined || seen.has(file)) {
            continue;
        }

        seen.add(file);
        const loader = loaderFor(file);

        if (loader === null) {
            continue;
        }

        const source = await Bun.file(file).text();
        let specifiers: string[];

        try {
            specifiers = new Bun.Transpiler({ loader }).scanImports(source).map((imported) => imported.path);
        } catch (error) {
            logger.debug({ error, file }, "import-graph: module did not parse; searching its text instead");

            if (packages.some((name) => source.includes(name))) {
                importers.add(dirname(file));
            }

            continue;
        }

        for (const specifier of specifiers) {
            const target = specifier.startsWith("#") ? mappedImport(specifier, dirname(file)) : specifier;

            if (target === null) {
                continue;
            }

            if (packages.some((name) => target === name || target.startsWith(`${name}/`))) {
                importers.add(dirname(file));
                continue;
            }

            if (!target.startsWith(".") && !target.startsWith("/")) {
                continue;
            }

            try {
                queue.push(Bun.resolveSync(target, dirname(file)));
            } catch (error) {
                logger.debug({ error, file, specifier }, "import-graph: local import does not resolve");
            }
        }
    }

    return [...importers];
}
