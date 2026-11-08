import type { AreaGrouping } from "./areas";
import { type ImportIndex, importersOf, labelOf, realPath } from "./import-index";
import type { LoadedFile } from "./load";
import { STRING_OR_COMMENT } from "./refactors/longFunctions";
import type { SkeletonSymbol } from "./skeleton";

export type DepthUnit = "folder" | "file";

export const DEPTH_UNITS: DepthUnit[] = ["folder", "file"];

/** An exported function whose body has at most this many lines is a thin export: it forwards. */
export const THIN_BODY_LINES = 3;

/** Containers whose members a caller reads as part of the export: a class's methods, an interface's fields. */
const MEMBER_CONTAINERS = new Set(["class", "interface", "enum", "const", "namespace"]);
const TYPE_KINDS = new Set(["interface", "type"]);

export interface ModuleDepth {
    /** A folder area (`src/utils/ai`) or a file path, relative to the cwd. */
    module: string;
    files: number;
    /** Exported names. A re-export statement counts one per name it lists, `export *` counts one. */
    exports: number;
    /** Of `exports`, the names re-exported from another module (`export … from`): pass-through. */
    reexports: number;
    /** `reexports / exports`. */
    reexportRatio: number;
    exportedFunctions: number;
    /** Exported functions whose body is at most three lines. */
    thinExports: number;
    /**
     * The interface, in characters: every exported declaration's signature with whitespace collapsed,
     * plus the non-private members of an exported class, interface, enum, namespace or object API.
     */
    interfaceChars: number;
    /** The implementation, in characters: the module's text with comments removed and whitespace collapsed. */
    codeChars: number;
    /** Non-blank lines that are not only a comment. */
    codeLines: number;
    /** `interfaceChars / codeChars`, at most 1: how much of the module a caller must read to use it. */
    interfaceShare: number;
    /** `codeLines / exports`: behaviour behind each exported name. */
    linesPerExport: number;
    /** Distinct files outside the module (and inside `--within`) that import it. */
    importerFiles: number;
    /** Distinct areas those importers sit in. */
    importerAreas: number;
    /** Every export is an interface or a type alias, so the module holds no behaviour to hide. */
    typesOnly: boolean;
    /** `0.6 × interfaceShare + 0.4 × (reexports + thinExports) / exports`, 0 to 1: higher is shallower. */
    shallow: number;
    /** `linesPerExport × log2(1 + importerFiles)`: much behaviour behind few names, used widely. */
    deep: number;
}

export interface DepthReport {
    by: DepthUnit;
    /** Where importers were counted. */
    within: string[];
    scanned: { files: number; modules: number };
    /** Modules left out of the shallow ranking, and why. */
    skipped: { typesOnly: number; fewExports: number };
    shallow: ModuleDepth[];
    deep: ModuleDepth[];
    /** Every module, in the order of `module`. */
    modules: ModuleDepth[];
}

export interface DepthOptions {
    by: DepthUnit;
    /** Labels for the report: the `--within` paths as typed. */
    within: string[];
    /** Groups the scanned files into folder modules (`--by folder`). */
    moduleGrouping: AreaGrouping;
    /** Groups the importers into areas. */
    importerGrouping: AreaGrouping;
    /** A module needs this many exports to be ranked shallow. Default 2. */
    minExports?: number;
    /** Rows in the shallow table. Default 25. */
    limit?: number;
    /** Rows in the deep table. Default 10. */
    deepLimit?: number;
    /** The folder module and file labels are relative to. Defaults to the index's cwd. */
    cwd?: string;
}

interface Tally {
    module: string;
    paths: Set<string>;
    exports: number;
    reexports: number;
    typeExports: number;
    exportedFunctions: number;
    thinExports: number;
    interfaceChars: number;
    codeChars: number;
    codeLines: number;
}

function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** The text without comments, string literals kept, so `"https://…"` survives and `// note` does not. */
function withoutComments(text: string): string {
    return text.replace(STRING_OR_COMMENT, (match) => {
        if (match.startsWith("//")) {
            return "";
        }

        if (match.startsWith("/*")) {
            return match.replace(/[^\n]/g, "");
        }

        return match;
    });
}

function codeSize(text: string): { chars: number; lines: number } {
    const code = withoutComments(text);
    let lines = 0;

    for (const line of code.split("\n")) {
        if (line.trim().length > 0) {
            lines++;
        }
    }

    return { chars: collapse(code).length, lines };
}

function headOf(symbol: SkeletonSymbol): string {
    return collapse(symbol.fullSignature ?? symbol.signature);
}

function isPrivate(symbol: SkeletonSymbol): boolean {
    return symbol.name.startsWith("#") || /\bprivate\b/.test(headOf(symbol).split("(")[0] ?? "");
}

function isThin(symbol: SkeletonSymbol): boolean {
    // A function with no body is an overload or a `declare`: nothing forwards there.
    if (symbol.bodyStartLine === undefined) {
        return false;
    }

    const bodyLines =
        symbol.endLine > symbol.bodyStartLine ? Math.max(1, symbol.endLine - symbol.bodyStartLine - 1) : 1;

    return bodyLines <= THIN_BODY_LINES;
}

function tallyFile(tally: Tally, entry: LoadedFile): void {
    const size = codeSize(entry.text);
    tally.codeChars += size.chars;
    tally.codeLines += size.lines;
    let top: SkeletonSymbol | undefined;

    for (const symbol of entry.symbols) {
        if (symbol.local) {
            continue;
        }

        if (symbol.depth === 0) {
            top = symbol;

            if (!symbol.exported || symbol.kind === "call") {
                continue;
            }

            tally.interfaceChars += headOf(symbol).length;

            if (symbol.kind === "re-export") {
                const names = symbol.name === "*" ? 1 : symbol.name.split(",").length;
                const head = headOf(symbol);
                tally.exports += names;

                if (/\bfrom\s*["']/.test(head)) {
                    tally.reexports += names;
                }

                if (/^export\s+type\b/.test(head)) {
                    tally.typeExports += names;
                }

                continue;
            }

            tally.exports++;

            if (TYPE_KINDS.has(symbol.kind)) {
                tally.typeExports++;
            }

            if (symbol.kind === "function") {
                tally.exportedFunctions++;

                if (isThin(symbol)) {
                    tally.thinExports++;
                }
            }

            continue;
        }

        if (top?.exported && top.depth === 0 && MEMBER_CONTAINERS.has(top.kind) && !isPrivate(symbol)) {
            tally.interfaceChars += headOf(symbol).length;
        }
    }
}

function round(value: number, digits: number): number {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

/**
 * Deep and shallow modules (Ousterhout's vocabulary): a module is deep when much behaviour sits
 * behind a small interface, shallow when the interface is nearly as big as the implementation.
 * Pass-through is the other shallow signal: a barrel that re-exports, a function that only forwards.
 */
export function measureDepth(entries: LoadedFile[], index: ImportIndex, options: DepthOptions): DepthReport {
    const cwd = options.cwd ?? index.cwd;
    const tallies = new Map<string, Tally>();

    for (const entry of entries) {
        const path = realPath(entry.absolute);
        const module = options.by === "file" ? labelOf(path, cwd) : options.moduleGrouping.areaOf(path);

        if (module === undefined) {
            continue;
        }

        let tally = tallies.get(module);

        if (!tally) {
            tally = {
                module,
                paths: new Set(),
                exports: 0,
                reexports: 0,
                typeExports: 0,
                exportedFunctions: 0,
                thinExports: 0,
                interfaceChars: 0,
                codeChars: 0,
                codeLines: 0,
            };
            tallies.set(module, tally);
        }

        tally.paths.add(path);
        tallyFile(tally, entry);
    }

    const importers = importersOf(index);
    const modules: ModuleDepth[] = [];

    for (const tally of tallies.values()) {
        const outside = new Set<string>();

        for (const path of tally.paths) {
            for (const importer of importers.get(path) ?? []) {
                if (!tally.paths.has(importer)) {
                    outside.add(importer);
                }
            }
        }

        const areas = new Set<string>();

        for (const importer of outside) {
            const area = options.importerGrouping.areaOf(importer);

            if (area !== undefined) {
                areas.add(area);
            }
        }

        const exports = tally.exports;
        const interfaceShare = tally.codeChars > 0 ? Math.min(1, tally.interfaceChars / tally.codeChars) : 1;
        const passThrough = exports > 0 ? Math.min(1, (tally.reexports + tally.thinExports) / exports) : 0;
        const linesPerExport = tally.codeLines / Math.max(1, exports);

        modules.push({
            module: tally.module,
            files: tally.paths.size,
            exports,
            reexports: tally.reexports,
            reexportRatio: round(exports > 0 ? tally.reexports / exports : 0, 3),
            exportedFunctions: tally.exportedFunctions,
            thinExports: tally.thinExports,
            interfaceChars: tally.interfaceChars,
            codeChars: tally.codeChars,
            codeLines: tally.codeLines,
            interfaceShare: round(interfaceShare, 3),
            linesPerExport: round(linesPerExport, 1),
            importerFiles: outside.size,
            importerAreas: areas.size,
            typesOnly: exports > 0 && tally.typeExports === exports,
            shallow: round(0.6 * interfaceShare + 0.4 * passThrough, 3),
            deep: round(linesPerExport * Math.log2(1 + outside.size), 1),
        });
    }

    modules.sort((a, b) => a.module.localeCompare(b.module));
    const minExports = options.minExports ?? 2;
    const typesOnly = modules.filter((module) => module.typesOnly);
    const fewExports = modules.filter((module) => !module.typesOnly && module.exports < minExports);
    const shallow = modules
        .filter((module) => !module.typesOnly && module.exports >= minExports)
        .sort((a, b) => b.shallow - a.shallow || b.importerFiles - a.importerFiles || a.module.localeCompare(b.module))
        .slice(0, options.limit ?? 25);
    const deep = modules
        .filter((module) => module.exports > 0 && module.importerFiles > 0 && !module.typesOnly)
        .sort((a, b) => b.deep - a.deep || a.module.localeCompare(b.module))
        .slice(0, options.deepLimit ?? 10);

    return {
        by: options.by,
        within: options.within,
        scanned: { files: entries.length, modules: modules.length },
        skipped: { typesOnly: typesOnly.length, fewExports: fewExports.length },
        shallow,
        deep,
        modules,
    };
}
