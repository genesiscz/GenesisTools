/**
 * fable-replace — `imports=fix` for Swift. Swift imports MODULES, not names, so a move needs
 * different work than in TypeScript:
 *
 * - Inside one module every file already sees every other file. The target only needs the module
 *   imports its new code relies on (copied from the source; an unused Swift import is harmless),
 *   and nothing `private` or `fileprivate` may be used across the cut.
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

/** `text` with comments (nested block comments too) and string bodies blanked; offsets are kept. */
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
            let j = open;
            while (j < text.length) {
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

            blank(open, j);
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
}

const IMPORT_LINE =
    /^(?:@\w+(?:\([^)\n]*\))?[ \t]+)*import[ \t]+(?:(?:typealias|struct|class|enum|protocol|let|var|func)[ \t]+)?([\w.]+)[ \t]*;?[ \t]*$/gm;

export const parseSwiftImports = (text: string, masked: string = maskSwift(text)): SwiftImport[] =>
    [...masked.matchAll(IMPORT_LINE)].map((match) => {
        const start = match.index ?? 0;
        const end = text.indexOf("\n", start);
        return { line: text.slice(start, end === -1 ? undefined : end).trimEnd(), module: match[1].split(".")[0] };
    });

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
        const end = raw.indexOf("\n", start);
        const line = raw.slice(start, end === -1 ? undefined : end);
        const written = modifiers.match(ACCESS_WORD)?.[1] as Access | undefined;
        const withAccess = (access: Access | ""): string => {
            const rest = modifiers.replace(ACCESS_WORD, "");
            const word = access === "" ? "" : `${access} `;
            return `${line.slice(0, attributes.length)}${word}${rest}${line.slice(attributes.length + modifiers.length)}`;
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
    const starts = [...text.matchAll(/\.(executableTarget|target|testTarget|macro|plugin)\s*\(/g)];
    const modules = starts.flatMap((match, k) => {
        const chunk = text.slice(match.index ?? 0, starts[k + 1]?.index ?? text.length);
        const name = chunk.match(/name:\s*"([^"]+)"/)?.[1];
        if (name === undefined) {
            return [];
        }

        const folder =
            chunk.match(/path:\s*"([^"]+)"/)?.[1] ?? `${match[1] === "testTarget" ? "Tests" : "Sources"}/${name}`;
        const list = chunk.match(/dependencies:\s*\[([\s\S]*?)\]\s*[,)]/)?.[1] ?? "";
        const dependencies = [...list.matchAll(/(?:name:\s*)?"([^"]+)"/g)].map((dep) => dep[1]);
        return [{ name, dir: path.resolve(path.dirname(packageFile), folder), packageFile, dependencies }];
    });
    packageCache.set(packageFile, modules);
    return modules;
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
    newImports: Set<string>;
    ops: Op[];
}

const compareModules = (a: string, b: string): number => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
};

/** The import lines a file gains, each next to its alphabetical neighbour, or on top when it has none. */
const importOps = (plan: SwiftFilePlan, label: string): Op[] => {
    const wanted = [...plan.newImports].filter(
        (module) => !plan.imports.some((existing) => existing.module === module)
    );
    if (wanted.length === 0) {
        return [];
    }

    if (plan.imports.length === 0) {
        const block = wanted
            .sort(compareModules)
            .map((module) => `import ${module}`)
            .join("\n");
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
    for (const module of wanted.sort(compareModules)) {
        const at = plan.imports.findIndex((existing) => compareModules(existing.module, module) > 0);
        if (at === -1) {
            after.push(`import ${module}`);
        } else {
            before.set(at, [...(before.get(at) ?? []), `import ${module}`]);
        }
    }

    const ops: Op[] = [];
    for (const [index, lines] of before) {
        const anchor = plan.imports[index].line;
        ops.push({ find: anchor, replace: [...lines, anchor].join("\n"), label });
    }

    if (after.length > 0) {
        const anchor = plan.imports[plan.imports.length - 1].line;
        if (before.has(plan.imports.length - 1)) {
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
const MEMBER = new RegExp(
    `^((?:@[\\w.]+(?:\\([^)\\n]*\\))?\\s+)*)((?:${MODIFIER})*)(func|var|let|init|subscript|typealias|struct|class|enum|actor)\\b`
);

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
            plan = { abs, text, imports: parseSwiftImports(text), newImports: new Set(), ops: [] };
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
    for (const sourceAbs of [...new Set(fixing.map((move) => move.fromAbs))]) {
        const source = planFor(sourceAbs);
        let remaining = source.text;
        for (const move of moves.filter((m) => m.fromAbs === sourceAbs)) {
            remaining = remaining.replace(move.cutText, "");
        }

        const remainingMasked = maskSwift(remaining);
        const remainingDecls = swiftDeclarations(remainingMasked, remaining);
        const sourceModule = swiftModuleOf(sourceAbs);

        for (const targetAbs of [...new Set(fixing.filter((m) => m.fromAbs === sourceAbs).map((m) => m.toAbs))]) {
            const toTarget = fixing.filter((m) => m.fromAbs === sourceAbs && m.toAbs === targetAbs);
            const first = toTarget[0];
            const widen = toTarget.some((move) => move.widen);
            const blocksRaw = toTarget.map((move) => move.blockText).join("\n");
            const blocks = maskSwift(blocksRaw);
            const movedDecls = new Map<string, { decl: SwiftDeclaration; move: PlannedMove }>();
            for (const move of toTarget) {
                for (const [name, decl] of swiftDeclarations(maskSwift(move.blockText), move.blockText)) {
                    movedDecls.set(name, { decl, move });
                }
            }

            const target = planFor(targetAbs);
            const targetModule = swiftModuleOf(targetAbs);
            const crossing = !sameModule(sourceModule, targetModule);
            for (const imported of source.imports) {
                if (imported.module !== targetModule?.name) {
                    target.newImports.add(imported.module);
                }
            }

            if (!crossing) {
                // One module: only file-scoped access can break.
                for (const [name, decl] of remainingDecls) {
                    if (isPrivate(decl.access) && usesName(blocks, name)) {
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

                        source.ops.push(widenOp(decl, "", name));
                    }
                }

                for (const [name, { decl, move }] of movedDecls) {
                    if (isPrivate(decl.access) && usesName(remainingMasked, name)) {
                        if (!move.widen) {
                            throw new MoveError(
                                withFix(
                                    `move: ${display(sourceAbs)} still uses ${name}, which is ${decl.access} and moves out`,
                                    {
                                        why: "let the move make it internal, or move its users along:",
                                        spec: markerWith(move, "visibility=widen"),
                                    }
                                ),
                                move.index
                            );
                        }

                        target.ops.push(widenOp(decl, "", name));
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

                const text = read(file) ?? "";
                for (const [name, decl] of swiftDeclarations(maskSwift(text), text)) {
                    if (!stays.has(name)) {
                        stays.set(name, { decl, file });
                    }
                }
            }

            const reached = [...stays].filter(([name]) => !movedDecls.has(name) && usesName(blocks, name));
            if (reached.length > 0) {
                throw new MoveError(
                    withFix(
                        `move: the moved code uses ${reached.map(([n]) => n).join(", ")}, which stay${reached.length === 1 ? "s" : ""} in module ${sourceModule.name}; ${targetModule.name} cannot see it`,
                        {
                            why: `move ${reached.length === 1 ? "it" : "them"} into ${targetModule.name} too:`,
                            spec: reached
                                .map(([n, info]) =>
                                    info.file === sourceAbs
                                        ? `<<< move to=${first.to} symbol=${n} imports=fix visibility=widen`
                                        : `@@ ${display(info.file)}\n<<< move to=${first.to} symbol=${n} imports=fix visibility=widen\n>>>`
                                )
                                .join("\n"),
                        }
                    ),
                    first.index
                );
            }

            // Every user of a moved declaration imports the target module, and the moved API is public.
            const movedNames = [...movedDecls.keys()];
            const users = swiftFiles.filter((file) => {
                if (file === targetAbs || file.startsWith(`${targetModule.dir}${path.sep}`)) {
                    return false;
                }

                const text = file === sourceAbs ? remaining : (read(file) ?? "");
                const masked = maskSwift(text);
                const inSourceModule = file.startsWith(`${sourceModule.dir}${path.sep}`);
                const importsSource = parseSwiftImports(text, masked).some((i) => i.module === sourceModule.name);
                return (inSourceModule || importsSource) && movedNames.some((name) => usesName(masked, name));
            });
            const usedOutside = new Set(
                movedNames.filter((name) =>
                    users.some((file) => usesName(maskSwift(file === sourceAbs ? remaining : (read(file) ?? "")), name))
                )
            );
            for (const file of users) {
                planFor(file).newImports.add(targetModule.name);
            }

            for (const name of usedOutside) {
                const entry = movedDecls.get(name);
                if (entry === undefined || isPublic(entry.decl.access)) {
                    continue;
                }

                if (!entry.move.widen) {
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

                const edited = blockEdits.get(entry.move) ?? new Map<number, string>();
                blockEdits.set(entry.move, edited);
                const lines = entry.move.blockText.split("\n");
                const declIndex = lines.indexOf(entry.decl.line);
                edited.set(declIndex, entry.decl.withAccess("public"));
                if (TYPE_KINDS.has(entry.decl.kind)) {
                    for (const [index, line] of publicMembers(lines, declIndex)) {
                        edited.set(index, line);
                    }
                }

                const builtOutside = users.some((file) =>
                    new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(
                        maskSwift(file === sourceAbs ? remaining : (read(file) ?? ""))
                    )
                );
                if (
                    entry.decl.kind === "struct" &&
                    builtOutside &&
                    !/^\s+(?:public\s+)?init\s*[(<]/m.test(entry.move.blockText)
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

            const packageText = fs.readFileSync(sourceModule.packageFile, "utf8");
            if (!sourceModule.dependencies.includes(targetModule.name) && usedOutside.size > 0) {
                const declared = packageText.match(
                    new RegExp(`name:\\s*"${sourceModule.name}"\\s*,\\s*dependencies:\\s*\\[`)
                )?.[0];
                warnWithFix(params, {
                    abs: sourceModule.packageFile,
                    needles: declared === undefined ? [] : [declared],
                    message: `imports=fix: target ${sourceModule.name} does not list ${targetModule.name} in its dependencies, so its new \`import ${targetModule.name}\` will not resolve`,
                    fix:
                        declared === undefined
                            ? {
                                  why: `add ${targetModule.name} to the dependencies of target ${sourceModule.name} in ${display(sourceModule.packageFile)} (as a .product if it lives in another package).`,
                              }
                            : {
                                  why: "add it to the target's dependencies:",
                                  spec: literalOpSpec(
                                      display(sourceModule.packageFile),
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
