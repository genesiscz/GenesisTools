import { extname } from "node:path";
import type ts from "typescript";
import { closestName, defineTransclusion, TransclusionError } from "../registry";
import { caption, codeBlock, languageFor, provenanceMeta, readSource, sourceIdentity, splitLines } from "./shared";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export interface SymbolSpan {
    name: string;
    /** 1-based, inclusive, leading doc comment included. */
    start: number;
    end: number;
}

/**
 * Every named declaration of a TS/JS file with its line span: functions, classes, interfaces, types,
 * enums, namespaces, variables, and class members as `Class.member`.
 */
export function typescriptSymbols(tsModule: typeof ts, path: string, text: string): SymbolSpan[] {
    const source = tsModule.createSourceFile(path, text, tsModule.ScriptTarget.Latest, true);
    const spans: SymbolSpan[] = [];
    const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
    const add = (name: string, node: ts.Node): void => {
        spans.push({ name, start: lineOf(node.getStart(source, true)), end: lineOf(node.getEnd()) });
    };

    const visit = (node: ts.Node, owner: string | null): void => {
        if (
            (tsModule.isFunctionDeclaration(node) ||
                tsModule.isClassDeclaration(node) ||
                tsModule.isInterfaceDeclaration(node) ||
                tsModule.isTypeAliasDeclaration(node) ||
                tsModule.isEnumDeclaration(node) ||
                tsModule.isModuleDeclaration(node)) &&
            node.name
        ) {
            const name = node.name.getText(source);
            add(owner ? `${owner}.${name}` : name, node);

            if (tsModule.isClassDeclaration(node) || tsModule.isInterfaceDeclaration(node)) {
                for (const member of node.members) {
                    if (member.name && !tsModule.isComputedPropertyName(member.name)) {
                        add(`${name}.${member.name.getText(source)}`, member);
                    }
                }
            }
        }

        if (tsModule.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (tsModule.isIdentifier(declaration.name)) {
                    add(declaration.name.text, node);
                }
            }
        }

        if (tsModule.isModuleDeclaration(node) && node.body && tsModule.isModuleBlock(node.body)) {
            for (const statement of node.body.statements) {
                visit(statement, node.name.getText(source));
            }
        }
    };

    for (const statement of source.statements) {
        visit(statement, null);
    }

    return spans;
}

const DEFINITION_KEYWORDS =
    "def|func|function|fn|class|struct|enum|interface|protocol|extension|trait|impl|type|module|object|record";
const MODIFIERS =
    "(?:export\\s+|default\\s+|pub(?:\\([^)]*\\))?\\s+|public\\s+|private\\s+|protected\\s+|internal\\s+|" +
    "fileprivate\\s+|static\\s+|async\\s+|final\\s+|abstract\\s+|override\\s+|open\\s+|unsafe\\s+|@\\w+\\s+)*";

/**
 * The documented fallback for other languages. The definition is the first line that reads
 * `[modifiers] <keyword> <name>` (def, func, function, fn, class, struct, enum, interface, protocol,
 * extension, trait, impl, type, module, object, record). A line ending in `:` (Python) ends at the
 * first later non-blank line indented no deeper than it. Otherwise the braces are balanced from that
 * line; with no `{` in the first three lines the definition is that line alone.
 */
export function heuristicSymbol(lines: string[], name: string): SymbolSpan | null {
    const definition = new RegExp(`^\\s*${MODIFIERS}(?:${DEFINITION_KEYWORDS})\\s+${escapeRegExp(name)}\\b`);
    const index = lines.findIndex((line) => definition.test(line));

    if (index === -1) {
        return null;
    }

    const head = lines[index];

    if (/:\s*(#.*)?$/.test(head)) {
        const indent = indentation(head);
        let end = index;

        for (let i = index + 1; i < lines.length; i++) {
            if (!lines[i].trim()) {
                continue;
            }

            if (indentation(lines[i]) <= indent) {
                break;
            }

            end = i;
        }

        return { name, start: index + 1, end: end + 1 };
    }

    let depth = 0;
    let opened = false;

    for (let i = index; i < lines.length; i++) {
        for (const char of stripStrings(lines[i])) {
            if (char === "{") {
                depth++;
                opened = true;
            } else if (char === "}") {
                depth--;
            }
        }

        if (opened && depth <= 0) {
            return { name, start: index + 1, end: i + 1 };
        }

        if (!opened && i - index >= 2) {
            break;
        }
    }

    return { name, start: index + 1, end: index + 1 };
}

function indentation(line: string): number {
    return (/^\s*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;
}

function stripStrings(line: string): string {
    return line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$/g, "");
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const symbolTransclusion = defineTransclusion({
    name: "symbol",
    description:
        "The body of one function, class, method (Class.method), interface, type or const. TS/JS files are " +
        "parsed with the TypeScript compiler; other languages use a keyword + brace/indent heuristic.",
    params: [
        { name: "path", type: "path", required: true, description: "The source file." },
        { name: "name", type: "string", required: true, description: "The symbol name; Class.member for a member." },
        { name: "commit", type: "string", description: "Read the file at this commit." },
    ],
    examples: [
        '{{symbol path="src/utils/transclude/engine.ts" name="transclude"}}',
        '{{symbol path="src/a.swift" name="HubWindow.refresh"}}',
    ],
    action: "substitute",
    async resolve(params, ctx) {
        const path = params.string("path");
        const name = params.string("name");
        const source = await readSource({ path, commit: params.optionalString("commit"), ctx });
        const lines = splitLines(source.text);
        let span: SymbolSpan | null = null;
        let method = "heuristic";
        let known: string[] = [];

        if (TS_EXTENSIONS.has(extname(path).toLowerCase())) {
            // lazy: saves ~80 ms cold import (hyperfine, bun -e import("typescript") 91.1 ms vs 11.5 ms, 2026-09-30) — only this kind needs it
            const tsModule = (await import("typescript")).default;
            const symbols = typescriptSymbols(tsModule, path, source.text);
            span = symbols.find((symbol) => symbol.name === name) ?? null;
            known = symbols.map((symbol) => symbol.name);
            method = "typescript";
        } else {
            span = heuristicSymbol(lines, name.split(".").pop() ?? name);
        }

        if (!span) {
            const hint = closestName(name, known);
            throw new TransclusionError(
                `symbol "${name}" not found in ${path}${hint ? ` (did you mean ${hint}?)` : ""}`
            );
        }

        const shown = `${span.start}-${span.end}`;
        return {
            markdown: codeBlock({
                text: lines.slice(span.start - 1, span.end).join("\n"),
                lang: languageFor(path),
                title: `${caption({ path, provenance: source.provenance, suffix: shown })} · ${name}`,
            }),
            meta: { ...provenanceMeta(source.provenance), symbol: name, lines: shown, method },
            block: true,
            source: sourceIdentity({ path, provenance: source.provenance }),
        };
    },
});
