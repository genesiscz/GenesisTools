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

function collapse(text: string): string {
    const single = text
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[{(,]$/, "")
        .trim()
        // A generic arrow keeps its `=>` when the body is cut away, which reads as unfinished.
        .replace(/=>$/, "")
        .trim();

    return single.length > MAX_SIGNATURE ? `${single.slice(0, MAX_SIGNATURE - 1)}…` : single;
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

function nameOf(node: ts.NamedDeclaration, source: ts.SourceFile): string {
    return node.name ? node.name.getText(source) : "<anonymous>";
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
                const initializer = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
                const isFn =
                    initializer !== undefined &&
                    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
                const body = isFn ? (initializer as ts.ArrowFunction | ts.FunctionExpression).body : undefined;

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
                    const isFn =
                        initializer !== undefined &&
                        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
                    const body = isFn ? (initializer as ts.ArrowFunction | ts.FunctionExpression).body : undefined;

                    push(
                        statement,
                        isFn ? "function" : "const",
                        nameOf(declaration, source),
                        signatureOf(statement, source, body),
                        depth
                    );
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
