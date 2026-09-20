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
}

const MAX_TYPE_LINES = 40;
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
export function collectTypeNames(source: ts.SourceFile): string[] {
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

        ts.forEachChild(node, visit);
    };

    ts.forEachChild(source, visit);

    return [...names].sort();
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

function toExpanded(source: ts.SourceFile, node: ts.Statement, name: string, file: string): ExpandedType {
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
    };
}

/** Same file first, then one hop through the import that introduced the name. */
export function expandTypes(source: ts.SourceFile, file: string, names: string[], root: string): ExpandedType[] {
    const found: ExpandedType[] = [];

    for (const name of names) {
        const local = declarationFor(source, name);

        if (local) {
            found.push(toExpanded(source, local, name, file));
            continue;
        }

        const specifier = importSpecifierFor(source, name);

        if (!specifier) {
            continue;
        }

        const target = resolveSpecifier(file, specifier, root);

        if (!target) {
            continue;
        }

        try {
            const imported = parseSource(target, readFileSync(target, "utf8"));
            const declaration = declarationFor(imported, name);

            if (declaration) {
                found.push(toExpanded(imported, declaration, name, target));
            }
        } catch {
            // An unreadable or unparsable module simply contributes no type.
        }
    }

    return found;
}
