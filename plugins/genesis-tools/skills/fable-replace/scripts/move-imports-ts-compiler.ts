/**
 * fable-replace — the TypeScript compiler as `imports=fix`'s reader, when a GenesisTools checkout
 * is found (`lib/locate-genesis-tools.ts`). It answers the same three questions the text reader
 * answers, from the syntax tree instead of patterns:
 *
 * - which statements are imports and re-exports, with exact spans (any formatting, any comments);
 * - which top-level declarations a text makes, exported or not, type-only or not;
 * - which names a text REFERS to: identifiers in reference position only, minus every name an
 *   inner scope declares (a parameter `join` no longer keeps `import { join }` alive).
 *
 * Only `createSourceFile` is used: no program, no type checker, so each file costs one parse.
 * The statement objects are the text reader's shape, so rendering stays byte-identical.
 */

import type * as TS from "typescript";
import { scanComments } from "./comments";
import type { DeclarationInfo, Declarations, ImportStatement, TsReader } from "./move-imports-ts";
import { parseNamedWithComments } from "./move-imports-ts";

const scriptKind = (ts: typeof TS, file: string): TS.ScriptKind => {
    if (/\.tsx$/.test(file)) {
        return ts.ScriptKind.TSX;
    }

    if (/\.jsx$/.test(file)) {
        return ts.ScriptKind.JSX;
    }

    return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
};

const blankComments = (text: string): string => {
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

/** Every name a binding pattern introduces: `a`, `{ a, b: c }`, `[d, ...e]`. */
const bindingNames = (ts: typeof TS, name: TS.BindingName): string[] =>
    ts.isIdentifier(name)
        ? [name.text]
        : name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(ts, element.name)));

/** Names a statement list declares for its own scope. */
const declaredBy = (ts: typeof TS, statements: readonly TS.Statement[]): string[] =>
    statements.flatMap((statement) => {
        if (ts.isVariableStatement(statement)) {
            return statement.declarationList.declarations.flatMap((d) => bindingNames(ts, d.name));
        }

        if (
            (ts.isFunctionDeclaration(statement) ||
                ts.isClassDeclaration(statement) ||
                ts.isEnumDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement)) &&
            statement.name !== undefined
        ) {
            return [statement.name.text];
        }

        return [];
    });

const typeParameterNames = (node: { typeParameters?: TS.NodeArray<TS.TypeParameterDeclaration> }): string[] =>
    (node.typeParameters ?? []).map((parameter) => parameter.name.text);

/** The names `node` declares for its descendants, or undefined when it opens no scope. */
const scopeOf = (ts: typeof TS, node: TS.Node): string[] | undefined => {
    if (ts.isFunctionLike(node)) {
        // Body declarations belong to the body Block's own scope: a parameter default such as
        // `x = helper()` reads the OUTER `helper` even when the body declares one of its own.
        const own = (ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name ? [node.name.text] : [];
        return [...own, ...node.parameters.flatMap((p) => bindingNames(ts, p.name)), ...typeParameterNames(node)];
    }

    if (ts.isBlock(node) || ts.isModuleBlock(node)) {
        return declaredBy(ts, node.statements);
    }

    if (ts.isCaseBlock(node)) {
        return node.clauses.flatMap((clause) => declaredBy(ts, clause.statements));
    }

    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        const initializer = node.initializer;
        return initializer !== undefined && ts.isVariableDeclarationList(initializer)
            ? initializer.declarations.flatMap((d) => bindingNames(ts, d.name))
            : [];
    }

    if (ts.isCatchClause(node)) {
        return node.variableDeclaration ? bindingNames(ts, node.variableDeclaration.name) : [];
    }

    if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        const own = ts.isClassExpression(node) && node.name ? [node.name.text] : [];
        return [...own, ...typeParameterNames(node)];
    }

    if (ts.isMappedTypeNode(node)) {
        return [node.typeParameter.name.text];
    }

    if (ts.isInferTypeNode(node)) {
        return [node.typeParameter.name.text];
    }

    return undefined;
};

/** Whether this identifier refers to a binding, as opposed to naming a property, a member or a declaration. */
const isReference = (ts: typeof TS, id: TS.Identifier): boolean => {
    const parent = id.parent;
    if (parent === undefined) {
        return false;
    }

    if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
        return false;
    }

    if (ts.isQualifiedName(parent) && parent.right === id) {
        return false;
    }

    if (ts.isImportTypeNode(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) {
        return false;
    }

    if (ts.isJsxAttribute(parent) && parent.name === id) {
        return false;
    }

    if (ts.isBindingElement(parent) && parent.propertyName === id) {
        return false;
    }

    if (ts.isExportSpecifier(parent)) {
        // `export { local as Public }`: the local side refers, the public side names.
        return parent.propertyName === undefined ? true : parent.propertyName === id;
    }

    const named = parent as TS.Node & { name?: TS.Node };
    if (named.name === id) {
        return ts.isShorthandPropertyAssignment(parent);
    }

    return true;
};

export const compilerReader = (ts: typeof TS): TsReader => {
    const parsed = new Map<string, TS.SourceFile>();
    const parse = (text: string, file: string): TS.SourceFile => {
        const key = `${file}\0${text}`;
        let sourceFile = parsed.get(key);
        if (sourceFile === undefined) {
            sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
            parsed.set(key, sourceFile);
        }

        return sourceFile;
    };

    const imports = (text: string, file: string): ImportStatement[] => {
        const sourceFile = parse(text, file);
        const out: ImportStatement[] = [];
        for (const statement of sourceFile.statements) {
            let keyword: "import" | "export";
            let typeOnly: boolean;
            let defaultName: string | undefined;
            let namespace: string | undefined;
            let namedNode: TS.NamedImports | TS.NamedExports | undefined;
            let star = false;
            let specifierNode: TS.Expression;
            if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
                const clause = statement.importClause;
                keyword = "import";
                typeOnly = clause.isTypeOnly;
                defaultName = clause.name?.text;
                const bindings = clause.namedBindings;
                if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
                    namespace = bindings.name.text;
                } else if (bindings !== undefined) {
                    namedNode = bindings;
                }

                specifierNode = statement.moduleSpecifier;
            } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
                keyword = "export";
                typeOnly = statement.isTypeOnly;
                const exportClause = statement.exportClause;
                if (exportClause === undefined) {
                    star = true;
                } else if (ts.isNamespaceExport(exportClause)) {
                    namespace = exportClause.name.text;
                } else {
                    namedNode = exportClause;
                }

                specifierNode = statement.moduleSpecifier;
            } else {
                continue;
            }

            if (!ts.isStringLiteral(specifierNode)) {
                continue;
            }

            const start = statement.getStart(sourceFile);
            const end = statement.end;
            const statementText = text.slice(start, end);
            let named: ImportStatement["named"];
            let multiline = false;
            let indent = "    ";
            let trailingComma = false;
            if (namedNode !== undefined) {
                const rawInner = text.slice(namedNode.getStart(sourceFile) + 1, namedNode.end - 1);
                const inner = blankComments(rawInner);
                named = parseNamedWithComments(rawInner, inner);
                multiline = inner.includes("\n");
                indent =
                    inner
                        .split("\n")
                        .find((line, k) => k > 0 && line.trim().length > 0)
                        ?.match(/^\s*/)?.[0] ?? "    ";
                trailingComma = inner.trimEnd().endsWith(",");
            }

            out.push({
                start,
                end,
                text: statementText,
                keyword,
                typeOnly,
                ...(defaultName === undefined ? {} : { defaultName }),
                ...(namespace === undefined ? {} : { namespace }),
                ...(named === undefined ? {} : { named }),
                star,
                specifier: specifierNode.text,
                quote: text[specifierNode.getStart(sourceFile)] ?? '"',
                semicolon: statementText.trimEnd().endsWith(";"),
                multiline,
                indent,
                trailingComma,
            });
        }

        return out;
    };

    const declarations = (text: string, file: string): Declarations => {
        const sourceFile = parse(text, file);
        const names = new Map<string, DeclarationInfo>();
        const exportedLocally = new Set<string>();
        let exportDefault = false;
        for (const statement of sourceFile.statements) {
            const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
            const exported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
            if (ts.isExportAssignment(statement) || modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
                exportDefault = true;
            }

            if (
                ts.isExportDeclaration(statement) &&
                statement.moduleSpecifier === undefined &&
                statement.exportClause
            ) {
                if (ts.isNamedExports(statement.exportClause)) {
                    for (const element of statement.exportClause.elements) {
                        exportedLocally.add((element.propertyName ?? element.name).text);
                    }
                }
                continue;
            }

            const start = statement.getStart(sourceFile);
            const lineEnd = text.indexOf("\n", start);
            const line = text.slice(start, lineEnd === -1 ? undefined : lineEnd);
            const add = (name: string, typeOnly: boolean): void => {
                const known = names.get(name);
                names.set(name, {
                    exported: exported || known?.exported === true,
                    typeOnly: typeOnly && known?.typeOnly !== false,
                    line: known?.line ?? line,
                });
            };
            if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
                add(statement.name.text, true);
            } else if (
                (ts.isFunctionDeclaration(statement) ||
                    ts.isClassDeclaration(statement) ||
                    ts.isEnumDeclaration(statement)) &&
                statement.name !== undefined
            ) {
                add(statement.name.text, false);
            } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
                add(statement.name.text, false);
            } else if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    for (const name of bindingNames(ts, declaration.name)) {
                        add(name, false);
                    }
                }
            }
        }

        for (const name of exportedLocally) {
            const known = names.get(name);
            if (known !== undefined) {
                known.exported = true;
            }
        }

        return { names, exportDefault };
    };

    const uses = (text: string, file: string): ((name: string) => boolean) => {
        const sourceFile = parse(text, file);
        const free = new Set<string>();
        const scopes: Array<Set<string>> = [];
        const visit = (node: TS.Node): void => {
            if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)) {
                return;
            }

            const scope = node === sourceFile ? undefined : scopeOf(ts, node);
            if (scope !== undefined) {
                scopes.push(new Set(scope));
            }

            if (ts.isIdentifier(node) && isReference(ts, node) && !scopes.some((names) => names.has(node.text))) {
                free.add(node.text);
            }

            ts.forEachChild(node, visit);
            if (scope !== undefined) {
                scopes.pop();
            }
        };
        visit(sourceFile);
        return (name: string) => free.has(name);
    };

    return { kind: "compiler", imports, declarations, uses };
};
