/**
 * fable-replace — RENAME A MODULE: its symbol, its file and every import of it, in one call.
 *
 *   run({ edits: renameModuleSymbol({ file: "src/Foo.ts", symbol: "Foo", to: "Bar", roots: ["src"] }), dryRun: true })
 *
 * It returns FileEdits only; run() does the work. The module file gets the word-bounded rename of the symbol plus
 * `renameTo: "src/Bar.ts"` and `gitMove: true` (run() stages a tracked file as a git rename). Every other file
 * under `roots` that names the identifier gets the same rename, and because the rename does not skip strings, every
 * specifier that ends in `/Foo` (`"./Foo"`, `"../Foo.js"`, `"@app/x/Foo"`) becomes `/Bar` with it. Each
 * FileEdit asks for the full diff, so the caller sees every changed line.
 *
 * The scope is the identifier, not the import graph: a file under `roots` that names `Foo` for another reason (a
 * package's own `Foo`) is renamed too. Narrow `roots` to keep such a file out, and read the diff.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FableReplaceError, identifierPattern } from "./internal";
import { findFiles } from "./recon";
import { renameSymbolAcross } from "./rename-symbols";
import { mergeFileEdits } from "./sweep-many-files";
import type { FileEdit } from "./types";

export interface RenameModuleSymbolParams {
    /** The module file, relative to `cwd` or absolute. Its base name must be the symbol: `src/Foo.ts` for `Foo`. */
    file: string;
    /** The identifier to rename. */
    symbol: string;
    /** The new identifier, which is also the new base name of the file (the extension stays). */
    to: string;
    /** Folders or files to search for the symbol, relative to `cwd` or absolute. The module file is always included. */
    roots: string[];
    /** Default: the process folder. A file inside it is named relative to it in the FileEdits. */
    cwd?: string;
    /** Also rename in files that import AND declare the symbol (a local wrapper); refused otherwise. */
    includeShadowed?: boolean;
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const SEARCHED_EXTS = [".ts", ".tsx"];
const PARAM_KEYS = ["file", "symbol", "to", "roots", "cwd", "includeShadowed"];

const refuse = (message: string): never => {
    throw new FableReplaceError(`renameModuleSymbol: ${message}`, 2);
};

/**
 * Renames the symbol in every file under roots that names it (specifiers ending in /<symbol> included), and the file
 * to <dir>/<to><ext> with gitMove: true. Every FileEdit it returns has diff: "full".
 *
 * Refused with code 2: a symbol or a new name that is not an identifier, the same name twice, a file whose base name
 * is not the symbol, a missing file or root, no root, and a second file under roots with the same base name (its
 * `…/Foo` specifiers would become `…/Bar` while that file keeps its name). A local wrapper is refused by
 * renameSymbolAcross unless `includeShadowed` is set. Files are searched with the extensions .ts and .tsx plus the
 * module file's own.
 */
export const renameModuleSymbol = ({
    file,
    symbol,
    to,
    roots,
    cwd,
    includeShadowed = false,
}: RenameModuleSymbolParams): FileEdit[] => {
    for (const [name, value] of [
        ["symbol", symbol],
        ["to", to],
    ]) {
        if (!IDENTIFIER_RE.test(value)) {
            refuse(`${name} "${value}" is not an identifier`);
        }
    }

    if (symbol === to) {
        refuse(`symbol and to are both "${symbol}"; there is nothing to rename`);
    }

    const base = path.resolve(cwd ?? ".");
    const moduleFile = path.resolve(base, file);
    const ext = path.extname(moduleFile);
    const baseName = path.basename(moduleFile, ext);
    if (baseName !== symbol) {
        refuse(
            `${file} is not named after "${symbol}" (its base name is "${baseName}"); rename that symbol with renameSymbolAcross and the file with renameTo`
        );
    }

    if (!fs.existsSync(moduleFile)) {
        refuse(`${file} not found under ${base}`);
    }

    if (roots.length === 0) {
        refuse("no root to search; pass at least one folder or file in roots");
    }

    const resolvedRoots = roots.map((root) => path.resolve(base, root));
    const missing = roots.filter((_root, i) => !fs.existsSync(resolvedRoots[i]));
    if (missing.length > 0) {
        refuse(`root(s) not found under ${base}: ${missing.join(", ")}`);
    }

    const shown = (abs: string): string => {
        const rel = path.relative(base, abs);
        return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? abs : rel;
    };
    const files = [
        ...new Set(
            findFiles({
                roots: [moduleFile, ...resolvedRoots],
                containing: new RegExp(identifierPattern(symbol)),
                exts: [...new Set([...SEARCHED_EXTS, ext])],
            })
        ),
    ];
    const twins = files.filter((other) => other !== moduleFile && path.basename(other, path.extname(other)) === symbol);
    if (twins.length > 0) {
        refuse(
            `${twins.map(shown).join(", ")} is also named "${symbol}": its imports end in /${symbol} too and would become /${to} while the file keeps its name. Narrow roots so that only ${file} is under them.`
        );
    }

    // Each file's count is pinned from what it holds now, so every rename op reports expected beside found.
    const identifier = new RegExp(identifierPattern(symbol), "g");
    const counts = Object.fromEntries(
        files.map((abs) => [abs, (fs.readFileSync(abs, "utf8").match(identifier) ?? []).length])
    );
    const renames = renameSymbolAcross({
        files: counts,
        oldName: symbol,
        newName: to,
        includeShadowed,
        extra: { diff: "full" },
    });
    return mergeFileEdits(
        [
            {
                file: shown(moduleFile),
                renameTo: shown(path.join(path.dirname(moduleFile), `${to}${ext}`)),
                gitMove: true,
                diff: "full",
            },
            ...renames.map((edit) => ({ ...edit, file: shown(edit.file) })),
        ],
        { cwd: base }
    );
};

/**
 * The JSON door of renameModuleSymbol (`--rename-module`, the MCP field `renameModule`): checks the shape as
 * editsFromJson does. A wrong type or an unknown key throws FableReplaceError code 2 naming its path ("roots[1]").
 */
export const renameModuleParamsFromJson = (value: unknown): RenameModuleSymbolParams => {
    const refuseAt = (at: string, problem: string): never => {
        throw new FableReplaceError(`renameModule JSON: ${at} ${problem}`, 2);
    };
    const kindOf = (field: unknown): string => {
        if (field === null) {
            return "null";
        }

        return Array.isArray(field) ? "an array" : typeof field;
    };

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return refuseAt("the top level", `must be an object { file, symbol, to, roots } (got ${kindOf(value)})`);
    }

    const fields = new Map<string, unknown>(Object.entries(value));
    for (const key of fields.keys()) {
        if (!PARAM_KEYS.includes(key)) {
            refuseAt(key, `is not a known key of a module rename (known: ${PARAM_KEYS.join(", ")})`);
        }
    }

    const optStr = (key: string): string | undefined => {
        const field = fields.get(key);
        if (field !== undefined && typeof field !== "string") {
            return refuseAt(key, `must be a string (got ${kindOf(field)})`);
        }

        return field;
    };
    const str = (key: string): string => optStr(key) ?? refuseAt(key, "is required (a string)");
    const roots = fields.get("roots");
    if (!Array.isArray(roots)) {
        return refuseAt("roots", `is required (an array of strings, got ${kindOf(roots)})`);
    }

    const includeShadowed = fields.get("includeShadowed");
    if (includeShadowed !== undefined && typeof includeShadowed !== "boolean") {
        return refuseAt("includeShadowed", `must be true or false (got ${kindOf(includeShadowed)})`);
    }

    const cwd = optStr("cwd");
    return {
        file: str("file"),
        symbol: str("symbol"),
        to: str("to"),
        roots: roots.map((root, index) =>
            typeof root === "string" ? root : refuseAt(`roots[${index}]`, `must be a string (got ${kindOf(root)})`)
        ),
        ...(cwd === undefined ? {} : { cwd }),
        ...(includeShadowed === undefined ? {} : { includeShadowed }),
    };
};
