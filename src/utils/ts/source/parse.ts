import ts from "typescript";

/**
 * TypeScript source read with the syntax API alone: no tsconfig, no type checker and no module
 * resolution, so it works against any worktree, any ref, and a file whose imports do not resolve.
 */

export interface ParsedSource {
    source: ts.SourceFile;
    /** Syntax errors. A syntax parse NEVER throws: it returns a tree with error nodes. */
    errors: string[];
}

export interface DeclarationSpan {
    name: string;
    start: number;
    end: number;
    /** An overload signature has no body; only the implementation does. */
    hasBody: boolean;
}

/** The parser's own diagnostics. The public API exposes them only through a Program. */
function parseDiagnosticsOf(source: ts.SourceFile): ts.Diagnostic[] {
    const diagnostics: unknown = Reflect.get(source, "parseDiagnostics");

    return Array.isArray(diagnostics) ? diagnostics : [];
}

/**
 * ⚠️ `createSourceFile` picks the script kind from the FILE NAME. A `.tsx` file parsed under a `.ts`
 * name yields a tree with zero JSX nodes and no exception, so always pass the real path.
 */
export function parseSource(path: string, text: string): ParsedSource {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

    return {
        errors: parseDiagnosticsOf(source).map((diagnostic) => {
            const { line } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);

            return `${path}:${line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
        }),
        source,
    };
}

function declaredName(node: ts.Node): string | undefined {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) {
        return node.name.text;
    }

    if ((ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)) && ts.isIdentifier(node.name)) {
        return node.name.text;
    }

    return ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
        ? node.name.text
        : undefined;
}

/**
 * Every declaration and the lines it spans, recursively: a helper nested inside a `describe` is a
 * declaration too, and a `source.statements` loop would miss it.
 */
export function declarationsIn(parsed: ParsedSource): DeclarationSpan[] {
    const found: DeclarationSpan[] = [];

    walk(parsed.source, (node) => {
        const name = declaredName(node);

        if (name !== undefined) {
            found.push({
                end: parsed.source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
                hasBody: "body" in node && Boolean(node.body),
                name,
                start: parsed.source.getLineAndCharacterOfPosition(node.getStart(parsed.source)).line + 1,
            });
        }
    });

    return found;
}

/** Every module a file imports from, as written. Type-only imports count: they are erased, but a missing path is still a broken edit. */
export function importsIn(parsed: ParsedSource): string[] {
    const found: string[] = [];

    for (const statement of parsed.source.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            found.push(statement.moduleSpecifier.text);
        }
    }

    return [...new Set(found)];
}

/** `visit` on `node` and on every node below it, depth first, parents first. */
export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
}

/** `(x as T)`, `(x)`, `x!`, `<T>x` -> x */
export function unwrap(node: ts.Expression): ts.Expression {
    let current = node;

    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isTypeAssertionExpression(current)
    ) {
        current = current.expression;
    }

    return current;
}

/** `f` for `f()` and `b` for `a.b()`, through any `unwrap` layer; null for any other callee. */
export function calleeName(call: ts.CallExpression | ts.NewExpression): string | null {
    const callee = unwrap(call.expression);

    if (ts.isIdentifier(callee)) {
        return callee.text;
    }

    if (ts.isPropertyAccessExpression(callee)) {
        return callee.name.text;
    }

    return null;
}

/** The text of a string literal or a template without substitutions; undefined for anything else. */
export function stringValue(node: ts.Node | undefined): string | undefined {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
        return node.text;
    }

    return undefined;
}
