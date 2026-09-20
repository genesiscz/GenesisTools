import ts from "typescript";

export interface SkeletonSymbol {
    kind: string;
    name: string;
    startLine: number;
    endLine: number;
    signature: string;
    exported: boolean;
    /** 0 for a top-level declaration, 1 for a class or interface member. */
    depth: number;
}

const MAX_SIGNATURE = 160;

function collapse(text: string): string {
    const single = text
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[{(,]$/, "")
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

    const visitMembers = (members: ts.NodeArray<ts.ClassElement | ts.TypeElement>): void => {
        for (const member of members) {
            if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
                const body = ts.isMethodDeclaration(member) ? member.body : undefined;
                push(member, "method", nameOf(member, source), signatureOf(member, source, body), 1);
            } else if (ts.isConstructorDeclaration(member)) {
                push(member, "constructor", "constructor", signatureOf(member, source, member.body), 1);
            } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
                const kind = ts.isGetAccessorDeclaration(member) ? "getter" : "setter";
                push(member, kind, nameOf(member, source), signatureOf(member, source, member.body), 1);
            }
        }
    };

    for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement)) {
            push(statement, "function", nameOf(statement, source), signatureOf(statement, source, statement.body), 0);
        } else if (ts.isClassDeclaration(statement)) {
            const head = statement.members.length > 0 ? statement.members[0] : undefined;
            push(statement, "class", nameOf(statement, source), signatureOf(statement, source, head), 0);
            visitMembers(statement.members);
        } else if (ts.isInterfaceDeclaration(statement)) {
            const head = statement.members.length > 0 ? statement.members[0] : undefined;
            push(statement, "interface", nameOf(statement, source), signatureOf(statement, source, head), 0);
            visitMembers(statement.members);
        } else if (ts.isTypeAliasDeclaration(statement)) {
            push(statement, "type", nameOf(statement, source), signatureOf(statement, source), 0);
        } else if (ts.isEnumDeclaration(statement)) {
            const head = statement.members.length > 0 ? statement.members[0] : undefined;
            push(statement, "enum", nameOf(statement, source), signatureOf(statement, source, head), 0);
        } else if (ts.isExportDeclaration(statement)) {
            // A barrel like `export { a, b } from "./x"` declares nothing, so without
            // this the whole file reads as empty. The `export` here is syntax rather
            // than a modifier, so `isExported` cannot see it.
            const clause = statement.exportClause;
            const names =
                clause && ts.isNamedExports(clause) ? clause.elements.map((element) => element.name.text) : ["*"];

            push(statement, "re-export", names.join(", "), signatureOf(statement, source), 0, true);
        } else if (ts.isExportAssignment(statement)) {
            push(statement, "default", "default", signatureOf(statement, source), 0, true);
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
                    0
                );
            }
        }
    }

    return symbols;
}

export function parseSource(filePath: string, text: string): ts.SourceFile {
    return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
}
