import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import ts from "typescript";
import { parseSource } from "./skeleton";

export interface ExpandedType {
    name: string;
    file: string;
    startLine: number;
    endLine: number;
    text: string;
    truncated: boolean;
    /** How far from the queried signatures this type was found: 1 is direct. */
    depth: number;
    /** Set when the type lives in a package rather than this repo, so it is named but not expanded. */
    external?: string;
}

const MAX_TYPE_LINES = 40;
const MAX_TYPES = 40;
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"];

/** Structural helpers and globals are noise here: the point is the project's own types. */
const BUILTIN = new Set([
    "Array",
    "Awaited",
    "Buffer",
    "Date",
    "Error",
    "Exclude",
    "Extract",
    "Map",
    "NonNullable",
    "Omit",
    "Parameters",
    "Partial",
    "Pick",
    "Promise",
    "Readonly",
    "Record",
    "RegExp",
    "Required",
    "ReturnType",
    "Set",
    "Uint8Array",
    "WeakMap",
    "WeakSet",
]);

/** Type positions only: a body's locals are not part of the API this prints. */
export function collectTypeNamesIn(root: ts.Node): string[] {
    const names = new Set<string>();

    const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) {
            for (const parameter of node.parameters) {
                visit(parameter);
            }

            if (node.type) {
                visit(node.type);
            }

            return;
        }

        if (ts.isTypeReferenceNode(node)) {
            const typeName = node.typeName;
            const text = ts.isIdentifier(typeName) ? typeName.text : typeName.right.text;

            if (!BUILTIN.has(text)) {
                names.add(text);
            }
        }

        // `type A = z.infer<typeof aSchema>` carries every field on the schema const,
        // so follow the `typeof` to it. Without this the whole config layer printed
        // as one useless line per type.
        if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) {
            names.add(node.exprName.text);
        }

        // `interface A extends B` is a heritage clause, not a type reference, so the
        // base's fields were invisible however deep the walk went.
        if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) {
            if (!BUILTIN.has(node.expression.text)) {
                names.add(node.expression.text);
            }
        }

        ts.forEachChild(node, visit);
    };

    ts.forEachChild(root, visit);

    return [...names].sort();
}

export function collectTypeNames(source: ts.SourceFile): string[] {
    return collectTypeNamesIn(source);
}

function tsconfigPaths(root: string): { baseUrl: string; paths: Record<string, string[]> } {
    const file = join(root, "tsconfig.json");

    if (!existsSync(file)) {
        return { baseUrl: root, paths: {} };
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(file, "utf8")) as {
            compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
        };
        const options = parsed.compilerOptions ?? {};

        return { baseUrl: resolve(root, options.baseUrl ?? "."), paths: options.paths ?? {} };
    } catch {
        return { baseUrl: root, paths: {} };
    }
}

function firstExisting(base: string): string | null {
    for (const suffix of CANDIDATE_SUFFIXES) {
        const candidate = `${base}${suffix}`;

        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return null;
}

export function resolveSpecifier(fromFile: string, specifier: string, root: string): string | null {
    if (specifier.startsWith(".")) {
        return firstExisting(resolve(dirname(fromFile), specifier));
    }

    const { baseUrl, paths } = tsconfigPaths(root);

    for (const [pattern, targets] of Object.entries(paths)) {
        const prefix = pattern.replace(/\*$/, "");

        if (!specifier.startsWith(prefix)) {
            continue;
        }

        const rest = specifier.slice(prefix.length);

        for (const target of targets) {
            const resolved = firstExisting(resolve(baseUrl, target.replace(/\*$/, "") + rest));

            if (resolved) {
                return resolved;
            }
        }
    }

    return null;
}

function declarationFor(source: ts.SourceFile, name: string): ts.Statement | null {
    for (const statement of source.statements) {
        const named =
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isClassDeclaration(statement);

        if (named && statement.name?.getText(source) === name) {
            return statement;
        }

        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (declaration.name.getText(source) === name) {
                    return statement;
                }
            }
        }
    }

    return null;
}

function importSpecifierFor(source: ts.SourceFile, name: string): string | null {
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) {
            continue;
        }

        const bindings = statement.importClause.namedBindings;

        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                if (element.name.text === name) {
                    return (statement.moduleSpecifier as ts.StringLiteral).text;
                }
            }
        }

        if (statement.importClause.name?.text === name) {
            return (statement.moduleSpecifier as ts.StringLiteral).text;
        }
    }

    return null;
}

function toExpanded(
    source: ts.SourceFile,
    node: ts.Statement,
    name: string,
    file: string,
    depth: number
): ExpandedType {
    const startLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const endLine = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const lines = source.text.slice(node.getStart(source), node.getEnd()).split("\n");

    return {
        name,
        file,
        startLine,
        endLine,
        text: lines.slice(0, MAX_TYPE_LINES).join("\n"),
        truncated: lines.length > MAX_TYPE_LINES,
        depth,
    };
}

/** Same file first, then one hop through the import that introduced the name. */
export function expandTypes(
    source: ts.SourceFile,
    file: string,
    names: string[],
    root: string,
    maxDepth = 2
): ExpandedType[] {
    const found: ExpandedType[] = [];
    const seen = new Set<string>();
    const queue: { name: string; source: ts.SourceFile; file: string; depth: number }[] = names.map((name) => ({
        name,
        source,
        file,
        depth: 1,
    }));

    while (queue.length > 0 && found.length < MAX_TYPES) {
        const job = queue.shift();

        if (!job || seen.has(job.name)) {
            continue;
        }

        seen.add(job.name);

        let declaration = declarationFor(job.source, job.name);
        let declarationSource = job.source;
        let declarationFile = job.file;

        if (!declaration) {
            const specifier = importSpecifierFor(job.source, job.name);

            if (!specifier) {
                continue;
            }

            const target = resolveSpecifier(job.file, specifier, root);

            if (!target) {
                // Only a BARE specifier is a package. A relative path that fails to
                // resolve is a missing file, and claiming it lives in a package is a lie.
                if (specifier.startsWith(".")) {
                    continue;
                }

                // Name the package rather than dropping it silently, so the reader
                // knows why it is not expanded.
                found.push({
                    name: job.name,
                    file: specifier,
                    startLine: 0,
                    endLine: 0,
                    text: `declared in "${specifier}", outside this repo`,
                    truncated: false,
                    depth: job.depth,
                    external: specifier,
                });
                continue;
            }

            try {
                declarationSource = parseSource(target, readFileSync(target, "utf8"));
                declarationFile = target;
                declaration = declarationFor(declarationSource, job.name);
            } catch {
                continue;
            }
        }

        if (!declaration) {
            continue;
        }

        found.push(toExpanded(declarationSource, declaration, job.name, declarationFile, job.depth));

        // One more hop: a field type, a union member or an `extends` base of a type we
        // just printed. Without this, `SpeakOptions extends TTSOptions` showed no fields.
        // A type alias is only another name for something, so following it does not
        // spend a level. That is what lets `X = z.infer<typeof xSchema>` reach the schema.
        const nextDepth = ts.isTypeAliasDeclaration(declaration) ? job.depth : job.depth + 1;

        if (nextDepth <= maxDepth) {
            for (const nested of collectTypeNamesIn(declaration)) {
                if (!seen.has(nested)) {
                    queue.push({
                        name: nested,
                        source: declarationSource,
                        file: declarationFile,
                        depth: nextDepth,
                    });
                }
            }
        }
    }

    return found;
}
