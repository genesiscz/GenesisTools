import { readFileSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { type CollectOptions, collectAll } from "./collect";
import { isBuiltinSpecifier, packageNameOf, resolveSpecifier } from "./graph";
import { languageFor, parseImports } from "./parse";
import type { ImportSite } from "./types";

const prof = profiler.scope("ts");

/**
 * `static` runs when the importer loads: an import or re-export statement, a side-effect import, a
 * module-scope `require()`. `dynamic` is `import()` (awaited or not) and a `require()` inside a
 * function: the target loads later, if ever.
 */
export type IndexedEdgeKind = "static" | "dynamic";

export interface IndexedImport {
    /** Real absolute path of the imported source file. */
    to: string;
    kind: IndexedEdgeKind;
    /** `import type` or `export type`: compile-time coupling, nothing loads at run time. */
    typeOnly: boolean;
    specifier: string;
    line: number;
}

export interface IndexedFile {
    /** Real absolute path. */
    path: string;
    /** Relative to the cwd, with forward slashes on every platform. */
    label: string;
    lines: number;
    /** Imports that resolved to a source file. Packages, builtins and assets are not edges here. */
    imports: IndexedImport[];
    /** Distinct npm packages the file imports. */
    packages: string[];
}

export interface ImportIndex {
    /** Real path of the cwd every label is relative to. */
    cwd: string;
    /** Every scanned file by real absolute path. */
    files: Map<string, IndexedFile>;
    unresolved: Array<{ file: string; specifier: string; line: number }>;
    /** Inputs that matched no TypeScript source. */
    empty: string[];
    /** Files that could not be read or parsed. They are absent from `files`. */
    failed: Array<{ file: string; error: string }>;
}

/** Real path, so a scanned path and a resolved import name the same file (macOS `/var` is `/private/var`). */
export function realPath(path: string): string {
    try {
        return realpathSync(path);
    } catch (error) {
        logger.debug({ path, error }, "ts: realpath failed, keeping the path as given");
        return path;
    }
}

export function labelOf(path: string, cwd: string): string {
    return (relative(cwd, path) || ".").replace(/\\/g, "/");
}

function lineCount(text: string): number {
    if (text.length === 0) {
        return 0;
    }

    let lines = text.endsWith("\n") ? 0 : 1;

    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
        lines++;
    }

    return lines;
}

function kindOf(site: ImportSite): IndexedEdgeKind {
    return site.kind === "dynamic" ? "dynamic" : "static";
}

/**
 * The whole-tree static import index behind `tools ts areas` and `tools ts depth`: every scanned
 * file with its line count and the source files it imports, resolved by Bun's resolver, so a
 * tsconfig `paths` alias (`@app/*`, `@genesiscz/utils/*`) resolves the way the runtime resolves it.
 * Built once per command; each command groups or ranks it its own way.
 */
export interface ImportIndexOptions extends CollectOptions {
    /** The folder labels are relative to. Defaults to the cwd. */
    cwd?: string;
}

export function buildImportIndex(paths: string[], options: ImportIndexOptions = {}): ImportIndex {
    const cwd = realPath(options.cwd ?? process.cwd());
    const { files: collected, empty } = prof.measure("index collect", () => collectAll(paths, options));
    const index: ImportIndex = { cwd, files: new Map(), unresolved: [], empty, failed: [] };

    prof.measure("index parse", () => {
        for (const collectedPath of collected) {
            const path = realPath(collectedPath);
            let text: string;
            let sites: ImportSite[];

            try {
                text = readFileSync(path, "utf8");
                sites = parseImports(text, path);
            } catch (error) {
                index.failed.push({ file: labelOf(path, cwd), error: String(error) });
                logger.warn({ file: path, error }, "ts: could not read or parse a file for the import index");
                continue;
            }

            const imports: IndexedImport[] = [];
            const packages = new Set<string>();

            for (const site of sites) {
                if (isBuiltinSpecifier(site.specifier)) {
                    continue;
                }

                const resolved = resolveSpecifier(site.specifier, path);

                if (!resolved) {
                    index.unresolved.push({ file: labelOf(path, cwd), specifier: site.specifier, line: site.line });
                    continue;
                }

                const pkg = packageNameOf(resolved);

                if (pkg) {
                    packages.add(pkg);
                    continue;
                }

                if (languageFor(resolved) === undefined) {
                    continue;
                }

                imports.push({
                    to: resolved,
                    kind: kindOf(site),
                    typeOnly: site.typeOnly,
                    specifier: site.specifier,
                    line: site.line,
                });
            }

            index.files.set(path, {
                path,
                label: labelOf(path, cwd),
                lines: lineCount(text),
                imports,
                packages: [...packages].sort(),
            });
        }
    });

    logger.debug(
        {
            paths,
            files: index.files.size,
            unresolved: index.unresolved.length,
            failed: index.failed.length,
        },
        "ts: import index built"
    );

    return index;
}

/**
 * The importers of every imported file, inverted from the index. The importers are indexed files;
 * a target may lie outside the index, so a module scanned apart from `--within` still finds them.
 */
export function importersOf(index: ImportIndex): Map<string, Set<string>> {
    const importers = new Map<string, Set<string>>();

    for (const file of index.files.values()) {
        for (const edge of file.imports) {
            if (edge.to === file.path) {
                continue;
            }

            const set = importers.get(edge.to) ?? new Set<string>();
            set.add(file.path);
            importers.set(edge.to, set);
        }
    }

    return importers;
}
