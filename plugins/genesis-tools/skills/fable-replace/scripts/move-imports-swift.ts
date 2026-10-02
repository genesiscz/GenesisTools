/**
 * fable-replace — `imports=fix` for Swift. Swift imports MODULES, not names, so a move needs
 * different work than in TypeScript:
 *
 * - Inside one module every file already sees every other file. The target only needs the module
 *   imports its new code relies on (copied from the source as written, `@testable` included; an
 *   unused Swift import is harmless), and nothing `private` or `fileprivate` may be used across the
 *   cut. An import under `#if` is not copied: it is a warning with the whole block, because a plain
 *   import of a module a platform lacks breaks that platform's build.
 * - Across modules (an app target into a package such as GenesisKit) the boundary comes from
 *   Package.swift. Every file that uses a moved declaration needs `import <TargetModule>`, the
 *   moved API needs `public`, the source target must depend on the target module, and the moved
 *   code cannot reach back into a module that does not depend on it.
 *
 * Source imports are never removed: Swift does not fail on an unused import, and which module a
 * name comes from is a type checker's question. Every refusal and warning carries a spec fix.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { scanComments } from "./comments";
import {
    listProjectFiles,
    literalOpSpec,
    MoveError,
    markerWith,
    type PlanImportFixesParams,
    type PlannedMove,
    toPosix,
    usesName,
    warnWithFix,
    withFix,
} from "./move-imports-shared";
import type { FileEdit, Op } from "./types";

/** The index of the `)` closing an interpolation whose body starts at `from`; nested strings and comments skipped. */
const interpolationEnd = (text: string, from: number): number => {
    let depth = 1;
    for (let k = from; k < text.length; k++) {
        const char = text[k];
        if (text.startsWith("//", k)) {
            const newline = text.indexOf("\n", k);
            k = newline === -1 ? text.length : newline;
            continue;
        }

        if (text.startsWith("/*", k)) {
            let nesting = 1;
            k += 2;
            while (k < text.length && nesting > 0) {
                const step = text.startsWith("/*", k) ? 1 : text.startsWith("*/", k) ? -1 : 0;
                nesting += step;
                k += step === 0 ? 1 : 2;
            }

            k--;
            continue;
        }

        if (char === '"') {
            k++;
            while (k < text.length && text[k] !== '"') {
                k += text[k] === "\\" ? 2 : 1;
            }

            continue;
        }

        if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth--;
            if (depth === 0) {
                return k;
            }
        }
    }

    return text.length;
};

/**
 * `text` with comments (nested block comments too) and string bodies blanked; offsets are kept.
 * An interpolation (`\(expr)`, `\#(expr)` in a raw string) is code and stays, itself masked.
 */
export const maskSwift = (text: string): string => {
    const chars = text.split("");
    const blank = (from: number, to: number): void => {
        for (let k = from; k < to && k < chars.length; k++) {
            if (chars[k] !== "\n") {
                chars[k] = " ";
            }
        }
    };
    let i = 0;
    while (i < text.length) {
        if (text.startsWith("//", i)) {
            const newline = text.indexOf("\n", i);
            const end = newline === -1 ? text.length : newline;
            blank(i, end);
            i = end;
            continue;
        }

        if (text.startsWith("/*", i)) {
            let depth = 0;
            let j = i;
            while (j < text.length) {
                if (text.startsWith("/*", j)) {
                    depth++;
                    j += 2;
                    continue;
                }

                if (text.startsWith("*/", j)) {
                    depth--;
                    j += 2;
                    if (depth === 0) {
                        break;
                    }
                    continue;
                }

                j++;
            }

            blank(i, j);
            i = j;
            continue;
        }

        const opener = /^(#*)("""|")/.exec(text.slice(i, i + 24));
        if (opener !== null && (opener[1].length > 0 || text[i] === '"')) {
            const [, hashes, quote] = opener;
            const open = i + hashes.length + quote.length;
            const close = `${quote}${hashes}`;
            const interpolation = `\\${hashes}(`;
            let literal = open;
            let j = open;
            while (j < text.length) {
                if (text.startsWith(interpolation, j)) {
                    const from = j + interpolation.length;
                    const end = interpolationEnd(text, from);
                    blank(literal, from);
                    const inner = maskSwift(text.slice(from, end));
                    for (let k = 0; k < inner.length; k++) {
                        chars[from + k] = inner[k];
                    }

                    literal = end;
                    j = end + 1;
                    continue;
                }

                if (hashes === "" && text[j] === "\\") {
                    j += 2;
                    continue;
                }

                if (quote === '"' && text[j] === "\n") {
                    break;
                }

                if (text.startsWith(close, j)) {
                    break;
                }

                j++;
            }

            blank(literal, j);
            i = Math.min(text.length, j + close.length);
            continue;
        }

        i++;
    }

    return chars.join("");
};

export interface SwiftImport {
    /** The line as written, the anchor an inserted import goes next to. */
    line: string;
    module: string;
    /** The imported path as written: `Foundation`, or `Foundation.Date` for a scoped import. */
    path: string;
    /** What one import is deduped by: the module, or the kind and path of a scoped import. */
    key: string;
    /** The whole outermost `#if … #endif` block when the import sits inside one. */
    ifBlock?: string;
}

const IMPORT_LINE =
    /^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*import[ \t]+(?:(typealias|struct|class|enum|protocol|let|var|func)[ \t]+)?([\w.]+)[ \t]*;?[ \t]*$/gm;

export const parseSwiftImports = (text: string, masked: string = maskSwift(text)): SwiftImport[] => {
    const lines = text.split("\n");
    const blockOf: Array<[number, number] | undefined> = [];
    let depth = 0;
    let opened = -1;
    for (const [index, line] of masked.split("\n").entries()) {
        const directive = line.trim();
        if (/^#if\b/.test(directive)) {
            opened = depth === 0 ? index : opened;
            depth++;
        } else if (/^#endif\b/.test(directive) && depth > 0) {
            depth--;
            if (depth === 0) {
                for (let k = opened; k <= index; k++) {
                    blockOf[k] = [opened, index];
                }
            }
        }
    }

    return [...masked.matchAll(IMPORT_LINE)].map((match) => {
        const start = match.index ?? 0;
        const end = text.indexOf("\n", start);
        const block = blockOf[masked.slice(0, start).split("\n").length - 1];
        const [, kind, importPath] = match;
        const module = importPath.split(".")[0];
        return {
            line: text.slice(start, end === -1 ? undefined : end).trimEnd(),
            module,
            path: importPath,
            key: kind === undefined ? module : `${kind} ${importPath}`,
            ...(block === undefined ? {} : { ifBlock: lines.slice(block[0], block[1] + 1).join("\n") }),
        };
    });
};

type Access = "private" | "fileprivate" | "internal" | "package" | "public" | "open";

export interface SwiftDeclaration {
    access: Access;
    /** `internal` because nothing was written, as opposed to a written `internal`. */
    implicit: boolean;
    kind: string;
    /** The declaration's line as written. */
    line: string;
    /** The same line with its access set to `access`, for a `visibility=widen` op. */
    withAccess: (access: Access | "") => string;
}

const MODIFIER =
    /(?:(?:public|open|internal|package|fileprivate|private)(?:\(set\))?|final|static|indirect|nonisolated(?:\(unsafe\))?|override|convenience|mutating|nonmutating|lazy|required|dynamic|weak|unowned|class(?=\s+(?:func|var|let)\b))\s+/
        .source;
const DECLARATION = new RegExp(
    `^((?:@[\\w.]+(?:\\([^)\\n]*\\))?\\s+)*)((?:${MODIFIER})*)(func|class|struct|enum|protocol|actor|typealias|let|var|extension|macro)\\s+([A-Za-z_]\\w*|\`[^\`]+\`)`,
    "gm"
);
const ACCESS_WORD = /\b(public|open|internal|package|fileprivate|private)\b(?!\()\s*/;

/** Declarations that start at column 0: a Swift file's top level. Extensions declare no name. */
export const swiftDeclarations = (masked: string, raw: string): Map<string, SwiftDeclaration> => {
    const out = new Map<string, SwiftDeclaration>();
    for (const match of masked.matchAll(DECLARATION)) {
        const [, attributes, modifiers, kind, rawName] = match;
        if (kind === "extension") {
            continue;
        }

        const start = match.index ?? 0;
        // Attributes can sit on lines of their own (`@MainActor` above `struct X`). The declaration
        // line is the one the keyword is on, and only the attributes on THAT line come before it.
        const declarationStart = raw.lastIndexOf("\n", start + attributes.length - 1) + 1;
        const end = raw.indexOf("\n", declarationStart);
        const line = raw.slice(declarationStart, end === -1 ? undefined : end);
        const sameLineAttributes = attributes.slice(declarationStart - start);
        const written = modifiers.match(ACCESS_WORD)?.[1] as Access | undefined;
        const withAccess = (access: Access | ""): string => {
            const rest = modifiers.replace(ACCESS_WORD, "");
            const word = access === "" ? "" : `${access} `;
            return `${line.slice(0, sameLineAttributes.length)}${word}${rest}${line.slice(sameLineAttributes.length + modifiers.length)}`;
        };
        out.set(rawName.replace(/`/g, ""), {
            access: written ?? "internal",
            implicit: written === undefined,
            kind,
            line,
            withAccess,
        });
    }

    return out;
};

export interface SwiftModule {
    name: string;
    dir: string;
    packageFile: string;
    dependencies: string[];
}

const packageCache = new Map<string, SwiftModule[]>();

/** The targets of a Package.swift, each with its folder: `path:` or the SwiftPM default. */
const readPackage = (packageFile: string): SwiftModule[] => {
    const cached = packageCache.get(packageFile);
    if (cached !== undefined) {
        return cached;
    }

    const text = maskSwiftKeepStrings(fs.readFileSync(packageFile, "utf8"));
    // A target's call runs to its closing paren. A `.target(name:)` in its dependencies or a
    // `.plugin(name:)` in its plugins sits inside that span and is no target of its own.
    const modules: SwiftModule[] = [];
    let insideUntil = -1;
    for (const match of text.matchAll(/\.(executableTarget|target|testTarget|macro|plugin)\s*\(/g)) {
        const start = match.index ?? 0;
        if (start < insideUntil) {
            continue;
        }

        insideUntil = closingBracket(text, start + match[0].length - 1);
        const chunk = text.slice(start, insideUntil + 1);
        const name = chunk.match(/name:\s*"([^"]+)"/)?.[1];
        if (name === undefined) {
            continue;
        }

        const folder =
            chunk.match(/path:\s*"([^"]+)"/)?.[1] ?? `${match[1] === "testTarget" ? "Tests" : "Sources"}/${name}`;
        const listStart = chunk.search(/dependencies:\s*\[/);
        const open = listStart === -1 ? -1 : chunk.indexOf("[", listStart);
        const list = open === -1 ? "" : chunk.slice(open + 1, closingBracket(chunk, open));
        const dependencies = [...list.matchAll(/(?:name:\s*)?"([^"]+)"/g)].map((dep) => dep[1]);
        modules.push({ name, dir: path.resolve(path.dirname(packageFile), folder), packageFile, dependencies });
    }

    packageCache.set(packageFile, modules);
    return modules;
};

/** The index of the `)` or `]` that closes the bracket at `open`, string bodies skipped. */
const closingBracket = (text: string, open: number): number => {
    let depth = 0;
    for (let k = open; k < text.length; k++) {
        const char = text[k];
        if (char === '"') {
            k++;
            while (k < text.length && text[k] !== '"') {
                k += text[k] === "\\" ? 2 : 1;
            }

            continue;
        }

        if (char === "(" || char === "[") {
            depth++;
        } else if (char === ")" || char === "]") {
            depth--;
            if (depth === 0) {
                return k;
            }
        }
    }

    return text.length - 1;
};

/** Comments blanked, strings kept: Package.swift's names and paths ARE strings. */
const maskSwiftKeepStrings = (text: string): string => {
    const chars = text.split("");
    for (const span of scanComments(text)) {
        for (let k = span.start; k < span.end; k++) {
            if (chars[k] !== "\n") {
                chars[k] = " ";
            }
        }
    }

    return chars.join("");
};

/** The SwiftPM target a file belongs to, or null outside any Package.swift target (an Xcode project). */
export const swiftModuleOf = (file: string): SwiftModule | null => {
    let dir = path.dirname(file);
    while (true) {
        const candidate = path.join(dir, "Package.swift");
        if (fs.existsSync(candidate)) {
            const owners = readPackage(candidate).filter((module) => file.startsWith(`${module.dir}${path.sep}`));
            return owners.sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
        }

        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }

        dir = parent;
    }
};

const sameModule = (a: SwiftModule | null, b: SwiftModule | null): boolean =>
    (a === null && b === null) || (a !== null && b !== null && a.packageFile === b.packageFile && a.name === b.name);

interface SwiftFilePlan {
    abs: string;
    text: string;
    imports: SwiftImport[];
    /** Import key → the import as the source wrote it. */
    newImports: Map<string, SwiftImport>;
    ops: Op[];
}

const compareModules = (a: string, b: string): number => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
};

/** The import lines a file gains, each next to its alphabetical neighbour, or on top when it has none. */
const importOps = (plan: SwiftFilePlan, label: string): Op[] => {
    // A plain import of the module already covers a scoped import from it.
    const wanted = [...plan.newImports.values()]
        .filter(
            (imported) =>
                !plan.imports.some((existing) => existing.key === imported.key || existing.key === imported.module)
        )
        .sort((a, b) => compareModules(a.path, b.path));
    if (wanted.length === 0) {
        return [];
    }

    // A new import never goes next to one under `#if`: it would land inside the condition.
    const anchors = plan.imports.filter((existing) => existing.ifBlock === undefined);
    if (anchors.length === 0) {
        const block = wanted.map((imported) => imported.line).join("\n");
        return [
            {
                kind: "regex",
                find: /^/g,
                replace: (...args: unknown[]): string => {
                    const whole = String(args[args.length - 1]);
                    return `${block}\n${whole.startsWith("\n") || whole.length === 0 ? "" : "\n"}`;
                },
                expect: 1,
                label,
            },
        ];
    }

    const before = new Map<number, string[]>();
    const after: string[] = [];
    for (const imported of wanted) {
        const at = anchors.findIndex((existing) => compareModules(existing.path, imported.path) > 0);
        if (at === -1) {
            after.push(imported.line);
        } else {
            before.set(at, [...(before.get(at) ?? []), imported.line]);
        }
    }

    const ops: Op[] = [];
    for (const [index, lines] of before) {
        const anchor = anchors[index].line;
        ops.push({ find: anchor, replace: [...lines, anchor].join("\n"), label });
    }

    if (after.length > 0) {
        const anchor = anchors[anchors.length - 1].line;
        if (before.has(anchors.length - 1)) {
            // Both sides of the last import grow: one op, or the second find would see the first's output.
            const op = ops.find((candidate) => "find" in candidate && candidate.find === anchor);
            if (op !== undefined && "replace" in op && typeof op.replace === "string") {
                op.replace = [op.replace, ...after].join("\n");
            }
        } else {
            ops.push({ find: anchor, replace: [anchor, ...after].join("\n"), label });
        }
    }

    return ops;
};

const TYPE_KINDS = new Set(["struct", "class", "enum", "actor"]);
const EXTENSION_LINE = new RegExp(`^(?:@[\\w.]+(?:\\([^)\\n]*\\))?\\s+)*(?:${MODIFIER})*extension\\s+[\\w.]+`);
const MEMBER = new RegExp(
    `^((?:@[\\w.]+(?:\\([^)\\n]*\\))?\\s+)*)((?:${MODIFIER})*)(func|var|let|init|subscript|typealias|struct|class|enum|actor)\\b`
);

/** The type's direct member lines (its first indentation level), indentation removed. */
const ownMembers = (lines: string[], declIndex: number): string[] => {
    const indent = lines
        .slice(declIndex + 1)
        .find((line) => line.trim() !== "")
        ?.match(/^\s+/)?.[0];
    const out: string[] = [];
    if (indent === undefined) {
        return out;
    }

    for (let k = declIndex + 1; k < lines.length; k++) {
        const line = lines[k];
        if (line.trim() !== "" && !line.startsWith(indent)) {
            break;
        }

        const body = line.slice(indent.length);
        if (body.trim() !== "" && !/^\s/.test(body)) {
            out.push(body);
        }
    }

    return out;
};

/** The type's direct members, written without an access word, each with `public` added. */
const publicMembers = (lines: string[], declIndex: number): Array<[number, string]> => {
    const out: Array<[number, string]> = [];
    const indent = lines
        .slice(declIndex + 1)
        .find((line) => line.trim() !== "")
        ?.match(/^\s+/)?.[0];
    if (indent === undefined) {
        return out;
    }

    for (let k = declIndex + 1; k < lines.length; k++) {
        const line = lines[k];
        if (line.trim() !== "" && !line.startsWith(indent)) {
            break;
        }

        const body = line.slice(indent.length);
        if (/^\s/.test(body)) {
            continue;
        }

        const member = MEMBER.exec(body);
        if (member === null || ACCESS_WORD.test(member[2])) {
            continue;
        }

        out.push([k, `${indent}${member[1]}public ${body.slice(member[1].length)}`]);
    }

    return out;
};

/** A public init over the struct's stored properties, the one Swift never writes for another module. */
const memberwiseInit = (lines: string[], declIndex: number): string => {
    const indent =
        lines
            .slice(declIndex + 1)
            .find((line) => line.trim() !== "")
            ?.match(/^\s+/)?.[0] ?? "    ";
    const stored: Array<{ name: string; type: string; fallback?: string }> = [];
    for (let k = declIndex + 1; k < lines.length; k++) {
        const line = lines[k];
        if (line.trim() !== "" && !line.startsWith(indent)) {
            break;
        }

        const property =
            /^(?:(?:public|internal|package)\s+)?(?:let|var)\s+(\w+)\s*:\s*([^={]+?)\s*(?:=\s*(.+?))?\s*$/.exec(
                line.slice(indent.length)
            );
        if (property !== null && !/^\s/.test(line.slice(indent.length))) {
            stored.push({ name: property[1], type: property[2], ...(property[3] ? { fallback: property[3] } : {}) });
        }
    }

    const parameters = stored
        .map((p) => `${p.name}: ${p.type}${p.fallback === undefined ? "" : ` = ${p.fallback}`}`)
        .join(", ");
    const body = stored.map((p) => `${indent}${indent}self.${p.name} = ${p.name}`).join("\n");
    return `${indent}public init(${parameters}) {\n${body}\n${indent}}\n`;
};

const isPrivate = (access: Access): boolean => access === "private" || access === "fileprivate";
const isPublic = (access: Access): boolean => access === "public" || access === "open";

export const planSwiftImportFixes = (params: PlanImportFixesParams): FileEdit[] => {
    const { moves, cwd, read } = params;
    const fixing = moves.filter((move) => move.fixImports);
    if (fixing.length === 0) {
        return [];
    }

    const display = (abs: string): string => toPosix(path.relative(cwd, abs));
    const plans = new Map<string, SwiftFilePlan>();
    const planFor = (abs: string): SwiftFilePlan => {
        let plan = plans.get(abs);
        if (plan === undefined) {
            const text = read(abs) ?? "";
            plan = { abs, text, imports: parseSwiftImports(text), newImports: new Map(), ops: [] };
            plans.set(abs, plan);
        }

        return plan;
    };
    const swiftFiles = (params.projectFiles ?? listProjectFiles(cwd)).filter((file) => file.endsWith(".swift"));
    const widenOp = (decl: SwiftDeclaration, access: Access | "", name: string): Op => ({
        find: decl.line,
        replace: decl.withAccess(access),
        label: `imports=fix: ${access === "" ? "internal" : access} ${name}`,
    });

    const blockEdits = new Map<PlannedMove, Map<number, string>>();
    // One remaining declaration can be widened for moves to several targets; its op goes in once.
    const widened = new Set<string>();
    const dependencyWarned = new Set<string>();
    const maskedFiles = new Map<string, string>();
    const maskedOf = (file: string): string => {
        let masked = maskedFiles.get(file);
        if (masked === undefined) {
            masked = maskSwift(read(file) ?? "");
            maskedFiles.set(file, masked);
        }

        return masked;
    };
    for (const sourceAbs of [...new Set(fixing.map((move) => move.fromAbs))]) {
        const source = planFor(sourceAbs);
        let remaining = source.text;
        for (const move of moves.filter((m) => m.fromAbs === sourceAbs)) {
            remaining = remaining.replace(move.cutText, "");
        }

        const remainingMasked = maskSwift(remaining);
        // The source is read after its cuts; every other file as it is.
        const textOf = (file: string): string => (file === sourceAbs ? remaining : (read(file) ?? ""));
        const maskedUser = (file: string): string => (file === sourceAbs ? remainingMasked : maskedOf(file));
        const remainingDecls = swiftDeclarations(remainingMasked, remaining);
        const sourceModule = swiftModuleOf(sourceAbs);

        for (const targetAbs of [...new Set(fixing.filter((m) => m.fromAbs === sourceAbs).map((m) => m.toAbs))]) {
            const toTarget = fixing.filter((m) => m.fromAbs === sourceAbs && m.toAbs === targetAbs);
            const first = toTarget[0];
            const widen = toTarget.some((move) => move.widen);
            const blocksRaw = toTarget.map((move) => move.blockText).join("\n");
            const blocks = maskSwift(blocksRaw);
            // Members, locals and parameters the moved code declares shadow outer names of the same spelling.
            const blockDeclares = new Set(
                [
                    ...blocks.matchAll(
                        /\b(?:func|var|let|case|class|struct|enum|actor|protocol|typealias)\s+([A-Za-z_]\w*)/g
                    ),
                ].map((match) => match[1])
            );
            const movedDecls = new Map<string, { decl: SwiftDeclaration; move: PlannedMove }>();
            for (const move of toTarget) {
                for (const [name, decl] of swiftDeclarations(maskSwift(move.blockText), move.blockText)) {
                    movedDecls.set(name, { decl, move });
                }
            }

            const target = planFor(targetAbs);
            const targetModule = swiftModuleOf(targetAbs);
            const crossing = !sameModule(sourceModule, targetModule);
            const conditional = new Set<string>();
            for (const imported of source.imports) {
                if (imported.module === targetModule?.name || target.newImports.has(imported.key)) {
                    continue;
                }

                if (imported.ifBlock !== undefined) {
                    conditional.add(imported.ifBlock);
                    continue;
                }

                // As written: `@testable`, `@preconcurrency` and `import struct …` keep their meaning.
                target.newImports.set(imported.key, { ...imported, line: imported.line.trim() });
            }

            for (const block of conditional) {
                if (target.text.includes(block)) {
                    continue;
                }

                const lastImport = target.imports.filter((existing) => existing.ifBlock === undefined).at(-1);
                const firstLine = (text: string): string | undefined =>
                    text.split("\n").find((candidate) => candidate.trim() !== "");
                const anchor = firstLine(target.text) ?? firstLine(first.blockText) ?? "";
                warnWithFix(params, {
                    abs: targetAbs,
                    needles: [block],
                    message: `imports=fix: ${display(sourceAbs)} imports under #if (${block.split("\n")[0].trim()}); a plain copy would break the platforms without that module, so it is not copied`,
                    fix: {
                        why: "if the moved code needs it, copy the whole block into the target:",
                        spec:
                            lastImport === undefined
                                ? `@@ ${display(targetAbs)}\n<<< before\n${anchor}\n===\n${block}\n>>>`
                                : `@@ ${display(targetAbs)}\n<<< after\n${lastImport.line}\n===\n${block}\n>>>`,
                    },
                });
            }

            if (!crossing) {
                // One module: only file-scoped access can break.
                for (const [name, decl] of remainingDecls) {
                    if (isPrivate(decl.access) && !blockDeclares.has(name) && usesName(blocks, name)) {
                        if (!widen) {
                            throw new MoveError(
                                withFix(
                                    `move: the moved code uses ${name}, which is ${decl.access} to ${display(sourceAbs)}`,
                                    {
                                        why: "move it along (first line), or let the move make it internal (second line):",
                                        spec: `<<< move to=${first.to} symbol=${name} imports=fix\n${markerWith(first, "visibility=widen")}`,
                                    }
                                ),
                                first.index
                            );
                        }

                        const key = `${sourceAbs}\u0000${decl.line}`;
                        if (!widened.has(key)) {
                            widened.add(key);
                            source.ops.push(widenOp(decl, "", name));
                        }
                    }
                }

                // Code this source sends to another file of the module is cut from `remaining` too,
                // yet from that file it uses a moved declaration just the same.
                const elsewhere = moves
                    .filter(
                        (m) =>
                            m.fromAbs === sourceAbs &&
                            m.toAbs !== targetAbs &&
                            sameModule(swiftModuleOf(m.toAbs), targetModule)
                    )
                    .map((m) => ({ move: m, masked: maskSwift(m.blockText) }));
                for (const [name, { decl, move }] of movedDecls) {
                    if (!isPrivate(decl.access)) {
                        continue;
                    }

                    const staysUser = usesName(remainingMasked, name);
                    const movingUser = elsewhere.find((other) => usesName(other.masked, name))?.move;
                    if (staysUser || movingUser !== undefined) {
                        if (!move.widen) {
                            const user = staysUser
                                ? `${display(sourceAbs)} still uses`
                                : `code moving to ${movingUser?.to} uses`;
                            throw new MoveError(
                                withFix(`move: ${user} ${name}, which is ${decl.access} and moves out`, {
                                    why: "let the move make it internal, or move its users along:",
                                    spec: markerWith(move, "visibility=widen"),
                                }),
                                move.index
                            );
                        }

                        // Through the whole-block rewrite, whose op the paste's own check follows.
                        const edited = blockEdits.get(move) ?? new Map<number, string>();
                        blockEdits.set(move, edited);
                        edited.set(move.blockText.split("\n").indexOf(decl.line), decl.withAccess(""));
                    }
                }

                continue;
            }

            if (sourceModule === null || targetModule === null) {
                const unknown = sourceModule === null ? first.from : first.to;
                throw new MoveError(
                    withFix(
                        `move: ${unknown} is in no Package.swift target, so the module boundary of this move is unknown`,
                        {
                            why: "move between files of one module, or drop imports=fix and fix the imports by hand:",
                            spec: first.marker.replace(" imports=fix", "").replace(" visibility=widen", ""),
                        }
                    ),
                    first.index
                );
            }

            // The moved code cannot see the module it left unless the target module depends on it.
            const sourceModuleFiles = swiftFiles.filter((file) => file.startsWith(`${sourceModule.dir}${path.sep}`));
            const stays = new Map<string, { decl: SwiftDeclaration; file: string }>();
            for (const [name, decl] of remainingDecls) {
                stays.set(name, { decl, file: sourceAbs });
            }

            for (const file of sourceModuleFiles) {
                if (file === sourceAbs) {
                    continue;
                }

                for (const [name, decl] of swiftDeclarations(maskedOf(file), read(file) ?? "")) {
                    if (!stays.has(name)) {
                        stays.set(name, { decl, file });
                    }
                }
            }

            // A name can also be a member reached through implicit `self` (`arguments` inside an
            // `extension Process`), which only the compiler can tell apart, so this is a warning.
            const reached = [...stays].filter(
                ([name]) => !movedDecls.has(name) && !blockDeclares.has(name) && usesName(blocks, name)
            );
            if (reached.length > 0) {
                const names = reached.map(([n]) => n).join(", ");
                warnWithFix(params, {
                    abs: targetAbs,
                    needles: [],
                    message: `imports=fix: the moved code names ${names}, declared in module ${sourceModule.name}, which ${targetModule.name} cannot see; if ${reached.length === 1 ? "it is" : "they are"} not a member reached through self, the build fails`,
                    fix: {
                        why: `if the build names ${reached.length === 1 ? "it" : "them"}, move ${reached.length === 1 ? "it" : "them"} into ${targetModule.name} too:`,
                        spec: `${reached
                            .map(
                                ([n, info]) =>
                                    `@@ ${display(info.file)}\n<<< move to=${first.to} symbol=${n} imports=fix visibility=widen\n>>>`
                            )
                            .join(
                                "\n"
                            )}\n# verify: --verify "swift build --package-path ${display(path.dirname(sourceModule.packageFile))}"`,
                    },
                });
            }

            // Every user of a moved declaration imports the target module, and the moved API is public.
            // A moved extension's members are moved API too: `process.runCapturing()` names no
            // moved type, yet its file needs the import and the member needs `public`.
            const movedNames = [...movedDecls.keys()];
            const extensionMembers = toTarget.flatMap((move) => {
                const lines = move.blockText.split("\n");
                return lines.flatMap((line, index) =>
                    EXTENSION_LINE.test(maskSwift(line))
                        ? publicMembers(lines, index).flatMap(([memberIndex, widened]) => {
                              const name = lines[memberIndex].match(/\b(?:func|var|let)\s+(\w+)/)?.[1];
                              return name === undefined ? [] : [{ move, memberIndex, widened, name }];
                          })
                        : []
                );
            });
            const callsMember = (masked: string, name: string): boolean => new RegExp(`\\.${name}\\b`).test(masked);
            const users = swiftFiles.filter((file) => {
                if (file === targetAbs || file.startsWith(`${targetModule.dir}${path.sep}`)) {
                    return false;
                }

                const text = textOf(file);
                const masked = maskedUser(file);
                const inSourceModule = file.startsWith(`${sourceModule.dir}${path.sep}`);
                const importsSource = parseSwiftImports(text, masked).some((i) => i.module === sourceModule.name);
                return (
                    (inSourceModule || importsSource) &&
                    (movedNames.some((name) => usesName(masked, name)) ||
                        extensionMembers.some((member) => callsMember(masked, member.name)))
                );
            });
            const calledMembers = extensionMembers.filter((member) =>
                users.some((file) => callsMember(maskedUser(file), member.name))
            );
            for (const member of calledMembers) {
                if (!member.move.widen) {
                    throw new MoveError(
                        withFix(
                            `move: ${member.name} moves into module ${targetModule.name} as an internal extension member, and ${sourceModule.name} still calls it`,
                            { why: "let the move make it public:", spec: markerWith(member.move, "visibility=widen") }
                        ),
                        member.move.index
                    );
                }

                const edited = blockEdits.get(member.move) ?? new Map<number, string>();
                blockEdits.set(member.move, edited);
                edited.set(member.memberIndex, member.widened);
            }
            const usedOutside = new Set(
                movedNames.filter((name) => users.some((file) => usesName(maskedUser(file), name)))
            );
            for (const file of users) {
                const plan = planFor(file);
                if (!plan.newImports.has(targetModule.name)) {
                    const name = targetModule.name;
                    plan.newImports.set(name, { line: `import ${name}`, module: name, path: name, key: name });
                }
            }

            for (const name of usedOutside) {
                const entry = movedDecls.get(name);
                if (entry === undefined) {
                    continue;
                }

                const alreadyPublic = isPublic(entry.decl.access);
                if (!alreadyPublic && !entry.move.widen) {
                    throw new MoveError(
                        withFix(
                            `move: ${name} moves into module ${targetModule.name} but is ${entry.decl.access}, and ${sourceModule.name} still uses it`,
                            {
                                why: "let the move make it and its members public:",
                                spec: markerWith(entry.move, "visibility=widen"),
                            }
                        ),
                        entry.move.index
                    );
                }

                const lines = entry.move.blockText.split("\n");
                const declIndex = lines.indexOf(entry.decl.line);
                // A public type's members written without an access word are still internal.
                const memberEdits = TYPE_KINDS.has(entry.decl.kind) ? publicMembers(lines, declIndex) : [];
                if (!entry.move.widen) {
                    if (memberEdits.length > 0) {
                        warnWithFix(params, {
                            abs: targetAbs,
                            needles: [],
                            message: `imports=fix: ${name} is public, but its members without an access word stay internal, out of reach for ${sourceModule.name}`,
                            fix: {
                                why: "let the move make them public:",
                                spec: markerWith(entry.move, "visibility=widen"),
                            },
                        });
                    }
                } else if (!alreadyPublic || memberEdits.length > 0) {
                    const edited = blockEdits.get(entry.move) ?? new Map<number, string>();
                    blockEdits.set(entry.move, edited);
                    if (!alreadyPublic) {
                        edited.set(declIndex, entry.decl.withAccess("public"));
                    }

                    for (const [index, line] of memberEdits) {
                        edited.set(index, line);
                    }
                }

                const builtOutside = users.some((file) =>
                    new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(maskedUser(file))
                );
                if (
                    entry.decl.kind === "struct" &&
                    builtOutside &&
                    !ownMembers(lines, declIndex).some((line) =>
                        /^(?:@\S+\s+)*(?:(?:public|internal|package|convenience|required)\s+)*init\s*[(<?]/.test(line)
                    )
                ) {
                    const init = memberwiseInit(lines, declIndex);
                    warnWithFix(params, {
                        abs: targetAbs,
                        needles: ["public init("],
                        message: `imports=fix: ${name} is built with its memberwise init outside ${targetModule.name}, and a memberwise init is never public`,
                        fix: {
                            why: "give it a public init:",
                            spec: `@@ ${display(targetAbs)}\n<<< after\n${entry.decl.withAccess("public")}\n===\n${init}\n>>>`,
                        },
                    });
                }
            }

            // Every module whose files gain `import <TargetModule>` must list it as a dependency:
            // the source module, and any module that imports the source module and uses moved API.
            const userModules = new Map<string, SwiftModule>();
            for (const file of users) {
                const module = swiftModuleOf(file);
                if (module !== null && !sameModule(module, targetModule)) {
                    userModules.set(`${module.packageFile}\u0000${module.name}`, module);
                }
            }

            for (const [key, module] of userModules) {
                if (
                    module.dependencies.includes(targetModule.name) ||
                    dependencyWarned.has(`${key}\u0000${targetModule.name}`)
                ) {
                    continue;
                }

                dependencyWarned.add(`${key}\u0000${targetModule.name}`);
                const packageText = fs.readFileSync(module.packageFile, "utf8");
                const declared = packageText.match(
                    new RegExp(`name:\\s*"${module.name}"\\s*,\\s*dependencies:\\s*\\[`)
                )?.[0];
                warnWithFix(params, {
                    abs: module.packageFile,
                    needles: declared === undefined ? [] : [declared],
                    message: `imports=fix: target ${module.name} does not list ${targetModule.name} in its dependencies, so its new \`import ${targetModule.name}\` will not resolve`,
                    fix:
                        declared === undefined
                            ? {
                                  why: `add ${targetModule.name} to the dependencies of target ${module.name} in ${display(module.packageFile)} (as a .product if it lives in another package).`,
                              }
                            : {
                                  why: "add it to the target's dependencies:",
                                  spec: literalOpSpec(
                                      display(module.packageFile),
                                      declared,
                                      `${declared}"${targetModule.name}", `
                                  ),
                              },
                });
            }
        }
    }

    for (const [move, edited] of blockEdits) {
        const lines = move.blockText.split("\n");
        for (const [index, line] of edited) {
            lines[index] = line;
        }

        // The pasted block is unique in the target, so one op rewrites every widened line of it.
        planFor(move.toAbs).ops.push({
            find: move.blockText,
            replace: lines.join("\n"),
            label: "imports=fix: public API",
        });
    }

    const edits: FileEdit[] = [];
    for (const plan of plans.values()) {
        const ops = [...importOps(plan, "imports=fix"), ...plan.ops];
        if (ops.length > 0) {
            edits.push({ file: display(plan.abs), ops });
        }
    }

    return edits;
};
