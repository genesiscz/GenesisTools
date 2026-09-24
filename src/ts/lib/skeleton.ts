import ts from "typescript";

export interface SkeletonSymbol {
    kind: string;
    name: string;
    startLine: number;
    endLine: number;
    signature: string;
    exported: boolean;
    /** 0 for a top-level declaration, 1 or more for a member or a namespace body. */
    depth: number;
}

const MAX_SIGNATURE = 160;

function collapsed(text: string): { text: string; truncated: boolean } {
    const single = text
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[{(,]$/, "")
        .trim()
        // A generic arrow keeps its `=>` when the body is cut away, which reads as unfinished.
        .replace(/=>$/, "")
        .trim()
        // `export const ui =` when the object literal is cut away, same reason.
        .replace(/=$/, "")
        .trim()
        // A source trailing comma reads as damage once the value is on one line: `{ "a": 1, }`.
        // Anchored at the very end, so a comma inside a string literal is never touched.
        .replace(/,\s*([}\]])$/, " $1");

    return single.length > MAX_SIGNATURE
        ? { text: `${single.slice(0, MAX_SIGNATURE - 1)}…`, truncated: true }
        : { text: single, truncated: false };
}

function collapse(text: string): string {
    return collapsed(text).text;
}

function isExported(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;

    return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** The declaration head only: everything before the body, so a 400-line function costs one line. */
function signatureOf(node: ts.Node, source: ts.SourceFile, body?: ts.Node): string {
    const start = node.getStart(source);
    const end = body ? body.getStart(source) : node.getEnd();

    return collapse(source.text.slice(start, end));
}

/**
 * For a declaration with members, cut at the `{` rather than at the first member.
 * A member's `getStart` sits after its own JSDoc, so cutting there dragged the whole
 * comment into the signature and then truncated it mid-sentence.
 */
function headOf(node: ts.Node, source: ts.SourceFile, members: ts.NodeArray<ts.Node>): string {
    return collapse(source.text.slice(node.getStart(source), members.pos));
}

/**
 * The function an initializer holds, looking through parentheses, `as`, `satisfies` and `<T>`
 * assertions. Testing the raw node missed `run: (() => 1)` and `run: fn as Handler`, so a
 * callable read as a field and a short object holding one was inlined as plain data.
 */
function functionOf(node: ts.Node | undefined): ts.ArrowFunction | ts.FunctionExpression | undefined {
    let current = node;

    while (
        current &&
        (ts.isParenthesizedExpression(current) ||
            ts.isAsExpression(current) ||
            ts.isSatisfiesExpression(current) ||
            ts.isTypeAssertionExpression(current))
    ) {
        current = current.expression;
    }

    return current && (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) ? current : undefined;
}

function nameOf(node: ts.NamedDeclaration, source: ts.SourceFile): string {
    return node.name ? node.name.getText(source) : "<anonymous>";
}

/**
 * `--exported`: the exported declarations, WITH the members that belong to them.
 *
 * 🛑 A member is kept only when its OWN parent survived. Filtering on `depth > 0` alone kept
 * every private declaration's members, and the list is flat and ordered, so they then read as
 * members of the previous surviving declaration. Measured 2026-09-22 on a file holding
 * `export const shown = { "k": 1 }` above `const hidden = { "k": 2 }`: the skeleton reported
 * `shown` as carrying BOTH fields. The only tell was a child whose line span sits outside its
 * parent's, which the `--json` and `--toon` forms give a reader no reason to check.
 */
export function exportedOnly(symbols: SkeletonSymbol[]): SkeletonSymbol[] {
    let keeping = false;

    return symbols.filter((symbol) => {
        if (symbol.depth === 0) {
            keeping = symbol.exported;
        }

        return keeping;
    });
}

export function extractSkeleton(source: ts.SourceFile): SkeletonSymbol[] {
    const symbols: SkeletonSymbol[] = [];

    const push = (
        node: ts.Node,
        kind: string,
        name: string,
        signature: string,
        depth: number,
        exported?: boolean
    ): void => {
        symbols.push({
            kind,
            name,
            startLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            signature,
            exported: exported ?? isExported(node),
            depth,
        });
    };

    const visitMembers = (members: ts.NodeArray<ts.ClassElement | ts.TypeElement>, depth: number): void => {
        for (const member of members) {
            if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
                const body = ts.isMethodDeclaration(member) ? member.body : undefined;
                push(member, "method", nameOf(member, source), signatureOf(member, source, body), depth);
            } else if (ts.isConstructorDeclaration(member)) {
                push(member, "constructor", "constructor", signatureOf(member, source, member.body), depth);
            } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
                const kind = ts.isGetAccessorDeclaration(member) ? "getter" : "setter";
                push(member, kind, nameOf(member, source), signatureOf(member, source, member.body), depth);
            } else if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
                // Interface fields are the cheapest high-value thing here: without them a
                // data-shape file printed as a list of empty names.
                const fn = functionOf(ts.isPropertyDeclaration(member) ? member.initializer : undefined);
                const isFn = fn !== undefined;
                const body = fn?.body;

                push(
                    member,
                    isFn ? "method" : "field",
                    nameOf(member, source),
                    signatureOf(member, source, body),
                    depth
                );
            }
        }
    };

    /**
     * An exported `const` whose value is an object literal is an API, not a value: `ui`,
     * `logger`, `out` and `SafeJSON` are all this shape. Printing only the declaration head
     * collapsed the whole surface into one truncated line, so a reader learned the name and
     * nothing else — `ui.raw` and `ui.err` were invisible, and the file had to be opened.
     *
     * `as const`, `satisfies` and a plain parenthesis all wrap the literal, so unwrap before
     * looking: `export const ui = ({ raw() {} })` is the same API as without the brackets.
     */
    const literalOf = (node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined => {
        let current = node;

        while (
            current &&
            (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))
        ) {
            current = current.expression;
        }

        return current && ts.isObjectLiteralExpression(current) ? current : undefined;
    };

    /**
     * `true` when a literal is plain DATA: no method, no accessor, no function-valued
     * property, at any depth. Such a literal has no API surface to list.
     */
    const isDataOnly = (literal: ts.ObjectLiteralExpression): boolean =>
        literal.properties.every((property) => {
            if (
                ts.isMethodDeclaration(property) ||
                ts.isGetAccessorDeclaration(property) ||
                ts.isSetAccessorDeclaration(property)
            ) {
                return false;
            }

            if (ts.isPropertyAssignment(property)) {
                const value = property.initializer;

                if (functionOf(value)) {
                    return false;
                }

                const nested = literalOf(value);

                return nested ? isDataOnly(nested) : true;
            }

            return true;
        });

    /**
     * The whole declaration with its literal INLINE, or `null` when it must be expanded.
     *
     * Expanding is right for a facade, where the members ARE the API. It is noise for a
     * value: `export const shown = { "k": 1 }` cost a head row plus a field row, and the two
     * together said less than the single line the source already had.
     *
     * 🛑 Size alone is the wrong test, and was tried first. It inlines a SHORT facade too,
     * and `export const api = ({ raw(): void {} })` then stops reporting `raw` as a method.
     * So both conditions hold: the literal must be plain data, AND the whole declaration must
     * still fit `MAX_SIGNATURE`. An inlined literal therefore shows every key it has.
     */
    const inlineLiteral = (node: ts.Node, literal: ts.ObjectLiteralExpression): string | null => {
        if (!isDataOnly(literal)) {
            return null;
        }

        const whole = collapsed(source.text.slice(node.getStart(source), literal.getEnd()));

        return whole.truncated ? null : whole.text;
    };

    const visitObjectMembers = (literal: ts.ObjectLiteralExpression, depth: number): void => {
        for (const property of literal.properties) {
            if (ts.isMethodDeclaration(property)) {
                push(property, "method", nameOf(property, source), signatureOf(property, source, property.body), depth);
                continue;
            }

            if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
                const kind = ts.isGetAccessorDeclaration(property) ? "getter" : "setter";

                push(property, kind, nameOf(property, source), signatureOf(property, source, property.body), depth);
                continue;
            }

            if (ts.isPropertyAssignment(property)) {
                const value = property.initializer;
                const fn = functionOf(value);
                const isFn = fn !== undefined;
                const body = fn?.body;
                const nested = literalOf(value);
                const inline = nested ? inlineLiteral(property, nested) : null;

                push(
                    property,
                    isFn ? "method" : "field",
                    nameOf(property, source),
                    inline ?? signatureOf(property, source, body ?? (nested ? nested : undefined)),
                    depth
                );

                if (nested && inline === null) {
                    visitObjectMembers(nested, depth + 1);
                }

                continue;
            }

            if (ts.isShorthandPropertyAssignment(property)) {
                push(property, "field", nameOf(property, source), property.getText(source), depth);
            }
        }
    };

    const visitStatements = (statements: ts.NodeArray<ts.Statement>, depth: number): void => {
        for (const statement of statements) {
            if (ts.isFunctionDeclaration(statement)) {
                push(
                    statement,
                    "function",
                    nameOf(statement, source),
                    signatureOf(statement, source, statement.body),
                    depth
                );
            } else if (ts.isClassDeclaration(statement)) {
                push(
                    statement,
                    "class",
                    nameOf(statement, source),
                    headOf(statement, source, statement.members),
                    depth
                );
                visitMembers(statement.members, depth + 1);
            } else if (ts.isInterfaceDeclaration(statement)) {
                push(
                    statement,
                    "interface",
                    nameOf(statement, source),
                    headOf(statement, source, statement.members),
                    depth
                );
                visitMembers(statement.members, depth + 1);
            } else if (ts.isTypeAliasDeclaration(statement)) {
                push(statement, "type", nameOf(statement, source), signatureOf(statement, source), depth);
            } else if (ts.isEnumDeclaration(statement)) {
                push(statement, "enum", nameOf(statement, source), headOf(statement, source, statement.members), depth);

                for (const member of statement.members) {
                    push(member, "field", nameOf(member, source), collapse(member.getText(source)), depth + 1);
                }
            } else if (ts.isModuleDeclaration(statement)) {
                // `namespace X {}` and `declare module "y" {}` were dropped entirely.
                const body = statement.body;
                push(
                    statement,
                    "namespace",
                    statement.name.getText(source),
                    signatureOf(statement, source, body),
                    depth
                );

                if (body && ts.isModuleBlock(body)) {
                    visitStatements(body.statements, depth + 1);
                }
            } else if (ts.isExportDeclaration(statement)) {
                // A barrel like `export { a, b } from "./x"` declares nothing, so without
                // this the whole file reads as empty. The `export` here is syntax rather
                // than a modifier, so `isExported` cannot see it.
                const clause = statement.exportClause;
                const names =
                    clause && ts.isNamedExports(clause) ? clause.elements.map((element) => element.name.text) : ["*"];

                push(statement, "re-export", names.join(", "), signatureOf(statement, source), depth, true);
            } else if (ts.isExportAssignment(statement)) {
                push(statement, "default", "default", signatureOf(statement, source), depth, true);
            } else if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    const initializer = declaration.initializer;
                    const fn = functionOf(initializer);
                    const isFn = fn !== undefined;
                    const body = fn?.body;

                    const literal = isFn ? undefined : literalOf(initializer);
                    // `const a = {…}, b = {…}` shares one statement, so a slice anchored at the
                    // statement start would carry the earlier declaration into the later one's
                    // signature. Only a lone declaration can be inlined from that anchor.
                    const declarations = statement.declarationList.declarations;
                    const alone = declarations.length === 1;
                    const inline = literal && alone ? inlineLiteral(statement, literal) : null;
                    // A shared statement is signed per declaration: its keywords (`export const`)
                    // and then this declaration alone, so `b` never carries `a = {…},` with it.
                    const keywords = source.text.slice(statement.getStart(source), declarations[0]?.getStart(source));
                    const signature = alone
                        ? signatureOf(statement, source, body ?? literal)
                        : collapse(`${keywords}${signatureOf(declaration, source, body ?? literal)}`);

                    push(
                        statement,
                        isFn ? "function" : "const",
                        nameOf(declaration, source),
                        inline ?? signature,
                        depth
                    );

                    if (literal && inline === null) {
                        visitObjectMembers(literal, depth + 1);
                    }
                }
            } else if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
                // A commander entrypoint is built from chained calls, which are expression
                // statements. Skipping them left `src/ts/index.ts` at 4.5% of its lines.
                const callee = statement.expression.expression.getText(source).split("\n")[0] ?? "call";

                push(statement, "call", collapse(callee), signatureOf(statement, source), depth, false);
            }
        }
    };

    visitStatements(source.statements, 0);

    return symbols;
}

export function parseSource(filePath: string, text: string): ts.SourceFile {
    return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
}
