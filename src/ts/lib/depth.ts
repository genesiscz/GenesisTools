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
    /**
     * Exported names. A re-export statement counts one per name it lists, `export *` counts one and
     * `export {}` none; `export { helper }` counts the declaration `helper` as if it said `export`.
     */
    exports: number;
    /** Of `exports`, the pass-through names: `export … from`, or an imported binding listed in `export { … }`. */
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

/** A top-level declaration with the members listed under it (a class's methods, an interface's fields). */
interface Declared {
    symbol: SkeletonSymbol;
    members: SkeletonSymbol[];
}

/** The names a re-export statement lists, without the empty one `export {}` leaves; `export *` is one. */
function listedNames(symbol: SkeletonSymbol): number {
    if (symbol.name === "*") {
        return 1;
    }

    return symbol.name
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean).length;
}

/** The local names `export { a, type B, c as d }` exports, read from its text: `a`, `B`, `c`. */
function exportedLocals(head: string): Array<{ local: string; typeOnly: boolean }> {
    const open = head.indexOf("{");
    const close = head.lastIndexOf("}");

    if (open === -1 || close < open) {
        return [];
    }

    const statementIsType = /^export\s+type\b/.test(head);

    return head
        .slice(open + 1, close)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => ({
            local:
                part
                    .replace(/^type\s+/, "")
                    .split(/\s+as\s+/)[0]
                    ?.trim() ?? part,
            typeOnly: statementIsType || /^type\s/.test(part),
        }));
}

/** One exported declaration: its head, the members a caller reads with it, and whether it is a type or a forwarder. */
function countDeclaration(tally: Tally, declared: Declared, typeOnly: boolean): void {
    const { symbol, members } = declared;
    tally.exports++;
    tally.interfaceChars += headOf(symbol).length;

    if (MEMBER_CONTAINERS.has(symbol.kind)) {
        for (const member of members) {
            if (!isPrivate(member)) {
                tally.interfaceChars += headOf(member).length;
            }
        }
    }

    if (typeOnly || TYPE_KINDS.has(symbol.kind)) {
        tally.typeExports++;
    }

    if (symbol.kind === "function") {
        tally.exportedFunctions++;

        if (isThin(symbol)) {
            tally.thinExports++;
        }
    }
}

function tallyFile(tally: Tally, entry: LoadedFile): void {
    const size = codeSize(entry.text);
    tally.codeChars += size.chars;
    tally.codeLines += size.lines;
    const declared: Declared[] = [];

    for (const symbol of entry.symbols) {
        if (symbol.local) {
            continue;
        }

        if (symbol.depth === 0) {
            declared.push({ symbol, members: [] });
        } else {
            declared.at(-1)?.members.push(symbol);
        }
    }

    // The declarations an `export { … }` list can name. A destructuring declaration is named by its
    // pattern (`{ a, b }`), so each identifier in it maps to it. An exported declaration is one too:
    // `export { helper as alias }` after `export function helper` is a second exported function.
    const locals = new Map<string, Declared>();

    for (const item of declared) {
        if (item.symbol.kind === "call" || item.symbol.kind === "re-export") {
            continue;
        }

        const names = /^[{[]/.test(item.symbol.name)
            ? (item.symbol.name.match(/[A-Za-z_$][\w$]*/g) ?? [])
            : [item.symbol.name];

        for (const name of names) {
            locals.set(name, item);
        }
    }

    for (const item of declared) {
        const { symbol } = item;

        if (!symbol.exported || symbol.kind === "call") {
            continue;
        }

        if (symbol.kind !== "re-export") {
            countDeclaration(tally, item, false);
            continue;
        }

        const head = headOf(symbol);

        if (/\bfrom\s*["']/.test(head)) {
            const names = listedNames(symbol);
            tally.exports += names;
            tally.reexports += names;
            tally.interfaceChars += names > 0 ? head.length : 0;

            if (/^export\s+type\b/.test(head)) {
                tally.typeExports += names;
            }

            continue;
        }

        // `export { helper }` exports a declaration made without `export`: count that declaration,
        // not the clause. A name with no declaration in the file is an imported binding sent on,
        // which is a pass-through like `export … from`.
        for (const { local, typeOnly } of exportedLocals(head)) {
            const target = locals.get(local);

            if (target) {
                countDeclaration(tally, target, typeOnly);
                continue;
            }

            tally.exports++;
            tally.reexports++;
            tally.interfaceChars += local.length;

            if (typeOnly) {
                tally.typeExports++;
            }
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
