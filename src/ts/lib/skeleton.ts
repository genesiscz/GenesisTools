import { createHash } from "node:crypto";
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
    /** First line of the declaration's body, when it has one. Always computed, rarely printed. */
    bodyStartLine?: number;
    /** True for a declaration inside a function body. Only collected with `locals`. */
    local?: boolean;
    /** Set by `enrichSymbols`: a fingerprint of the declaration with its own name blanked out. */
    hash?: string;
    /** Set by `enrichSymbols`: the first lines of the body, for `--function-context`. */
    body?: string[];
    /** True when `body` stops short of the declaration's real end. */
    bodyTruncated?: boolean;
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

export interface ExtractOptions {
    /**
     * Also collect declarations INSIDE function bodies. Off by default, because a helper
     * closure is not part of a file's API. It is the only way to see a `const git = …` that
     * lives three lines into a function, which a duplicate hunt very much wants.
     */
    locals?: boolean;
}

export function extractSkeleton(source: ts.SourceFile, options: ExtractOptions = {}): SkeletonSymbol[] {
    const symbols: SkeletonSymbol[] = [];
    let insideFunction = 0;

    const push = (
        node: ts.Node,
        kind: string,
        name: string,
        signature: string,
        depth: number,
        exported?: boolean,
        body?: ts.Node
    ): void => {
        symbols.push({
            kind,
            name,
            startLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            signature,
            exported: exported ?? isExported(node),
            depth,
            ...(body ? { bodyStartLine: source.getLineAndCharacterOfPosition(body.getStart(source)).line + 1 } : {}),
            ...(insideFunction > 0 ? { local: true } : {}),
        });
    };

    /**
     * Walk into a function body when `locals` is on. The nested statements go through the same
     * `visitStatements`, so a closure inside a closure is collected the same way as a top-level
     * declaration, one depth further in and flagged `local`.
     */
    const descend = (body: ts.Node | undefined, depth: number): void => {
        if (!options.locals || !body || !ts.isBlock(body)) {
            return;
        }

        insideFunction += 1;
        visitStatements(body.statements, depth + 1);
        insideFunction -= 1;
    };

    const visitMembers = (members: ts.NodeArray<ts.ClassElement | ts.TypeElement>, depth: number): void => {
        for (const member of members) {
            if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
                const body = ts.isMethodDeclaration(member) ? member.body : undefined;
                push(
                    member,
                    "method",
                    nameOf(member, source),
                    signatureOf(member, source, body),
                    depth,
                    undefined,
                    body
                );
                descend(body, depth);
            } else if (ts.isConstructorDeclaration(member)) {
                push(
                    member,
                    "constructor",
                    "constructor",
                    signatureOf(member, source, member.body),
                    depth,
                    undefined,
                    member.body
                );
                descend(member.body, depth);
            } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
                const kind = ts.isGetAccessorDeclaration(member) ? "getter" : "setter";
                push(
                    member,
                    kind,
                    nameOf(member, source),
                    signatureOf(member, source, member.body),
                    depth,
                    undefined,
                    member.body
                );
                descend(member.body, depth);
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
                    depth,
                    undefined,
                    body
                );
                descend(body, depth);
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

                if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
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
                push(
                    property,
                    "method",
                    nameOf(property, source),
                    signatureOf(property, source, property.body),
                    depth,
                    undefined,
                    property.body
                );
                descend(property.body, depth);
                continue;
            }

            if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
                const kind = ts.isGetAccessorDeclaration(property) ? "getter" : "setter";

                push(
                    property,
                    kind,
                    nameOf(property, source),
                    signatureOf(property, source, property.body),
                    depth,
                    undefined,
                    property.body
                );
                descend(property.body, depth);
                continue;
            }

            if (ts.isPropertyAssignment(property)) {
                const value = property.initializer;
                const isFn = ts.isArrowFunction(value) || ts.isFunctionExpression(value);
                const body = isFn ? (value as ts.ArrowFunction | ts.FunctionExpression).body : undefined;
                const nested = literalOf(value);
                const inline = nested ? inlineLiteral(property, nested) : null;

                push(
                    property,
                    isFn ? "method" : "field",
                    nameOf(property, source),
                    inline ?? signatureOf(property, source, body ?? (nested ? nested : undefined)),
                    depth,
                    undefined,
                    body
                );
                descend(body, depth);

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
                    depth,
                    undefined,
                    statement.body
                );
                descend(statement.body, depth);
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

                    const literal = isFn ? undefined : literalOf(initializer);
                    // `const a = {…}, b = {…}` shares one statement, so a slice anchored at the
                    // statement start would carry the earlier declaration into the later one's
                    // signature. Only a lone declaration can be inlined from that anchor.
                    const alone = statement.declarationList.declarations.length === 1;
                    const inline = literal && alone ? inlineLiteral(statement, literal) : null;

                    push(
                        statement,
                        isFn ? "function" : "const",
                        nameOf(declaration, source),
                        inline ?? signatureOf(statement, source, body ?? literal),
                        depth,
                        undefined,
                        body
                    );
                    descend(body, depth);

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

const LINE_COMMENT = /\/\/[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
/**
 * Stands in for the declaration's own name. It must be one character, must not be a control
 * character, and must not be an identifier character, so that it tokenises on its own and
 * never merges with the text beside it.
 */
const NAME_PLACEHOLDER = "·";

/**
 * The declaration reduced to what a reader would call "the same code": comments gone, the
 * declaration's OWN name blanked, whitespace collapsed.
 *
 * 🛑 Blanking the name is what makes a renamed copy visible. `walkFiles` and `walk` in
 * a sibling repo are the same six lines under two names, and a fingerprint that kept the name
 * would have called them unrelated. Only the declared name is blanked, never every
 * identifier, so two genuinely different functions do not collapse into one.
 */
export function normalizeDeclaration(text: string, name: string): string {
    const withoutComments = text.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, " ");
    // A name of `<anonymous>` or `*` is not an identifier, so it would build a broken pattern.
    const blanked = /^[A-Za-z_$][\w$]*$/.test(name)
        ? withoutComments.replace(new RegExp(`\\b${name}\\b`, "g"), NAME_PLACEHOLDER)
        : withoutComments;

    return blanked.replace(/\s+/g, " ").trim();
}

export function hashDeclaration(text: string, name: string): string {
    return createHash("sha1").update(normalizeDeclaration(text, name)).digest("hex").slice(0, 12);
}

/** The normalised declaration split into comparable pieces: identifiers, literals, operators. */
export function tokenizeDeclaration(text: string, name: string): string[] {
    return normalizeDeclaration(text, name).match(/[A-Za-z_$][\w$]*|\d+|[^\sA-Za-z0-9_$]/g) ?? [];
}

export interface EnrichOptions {
    /** Attach `hash` to every symbol. */
    hash?: boolean;
    /** Attach the first N lines of the body as `body`. 0 means no body. */
    functionContext?: number;
}

/**
 * Second pass over an extracted skeleton, for the fields that need the file's text rather than
 * its syntax tree. Kept apart from `extractSkeleton` so the common case pays nothing for them.
 */
export function enrichSymbols(symbols: SkeletonSymbol[], text: string, options: EnrichOptions): SkeletonSymbol[] {
    const wantHash = options.hash === true;
    const context = options.functionContext ?? 0;

    if (!wantHash && context <= 0) {
        return symbols;
    }

    const lines = text.split("\n");

    return symbols.map((symbol) => {
        const declaration = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
        const next: SkeletonSymbol = { ...symbol };

        if (wantHash) {
            next.hash = hashDeclaration(declaration, symbol.name);
        }

        if (context > 0) {
            // Start after the signature so the context is the part the skeleton does not
            // already print. A declaration with no body starts one line in.
            const from = symbol.bodyStartLine ?? symbol.startLine;
            const body = lines.slice(from, Math.min(from + context, symbol.endLine));

            if (body.length > 0) {
                next.body = body;
                next.bodyTruncated = from + context < symbol.endLine;
            }
        }

        return next;
    });
}
