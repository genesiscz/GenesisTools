import { EXT_TO_LANG, EXT_TO_LANGUAGE_NAME } from "@app/indexer/lib/ast-languages";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import type { ExtractedSymbol, SymbolKind } from "./types";

/** Language name → built-in ast-grep Lang (sync path; TS/TSX/JS only). */
const BUILTIN_LANG: Record<string, Lang> = {
    typescript: Lang.TypeScript,
    tsx: Lang.Tsx,
    javascript: Lang.JavaScript,
    jsx: Lang.Tsx,
};

/** declaration.kind() → our SymbolKind. */
const DECL_KIND_TO_SYMBOL: Record<string, SymbolKind> = {
    function_declaration: "function",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    lexical_declaration: "const",
    variable_declaration: "const",
};

/**
 * Access a named field on an SgNode. ast-grep's field() signature is
 * restrictive, so funnel all accesses through this cast wrapper
 * (same approach as src/indexer/lib/chunker.ts).
 */
function getNodeField(node: SgNode, fieldName: string): SgNode | null {
    type FieldAccessor = (name: string) => SgNode | null;
    return (node.field as FieldAccessor)(fieldName);
}

/** Collapse all interior whitespace runs to single spaces and trim. */
function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** Locate the body block to strip for a given declaration node, if any. */
function findBodyNode(declNode: SgNode): SgNode | null {
    const kind = declNode.kind();

    if (kind === "function_declaration") {
        return getNodeField(declNode, "body");
    }

    if (kind === "class_declaration") {
        return getNodeField(declNode, "body");
    }

    if (kind === "lexical_declaration" || kind === "variable_declaration") {
        const declarator = declNode.children().find((c) => c.kind() === "variable_declarator");

        if (!declarator) {
            return null;
        }

        const value = getNodeField(declarator, "value");

        if (value && value.kind() === "arrow_function") {
            return getNodeField(value, "body");
        }

        return null;
    }

    return null;
}

/**
 * Slice a declaration's source from its start up to (but excluding) its body
 * block, yielding a body-free signature. Falls back to the full text when no
 * body block exists (interfaces, type aliases).
 */
function signatureOf(exportNode: SgNode, declNode: SgNode): string {
    const full = exportNode.text();
    const bodyNode = findBodyNode(declNode);

    if (!bodyNode) {
        return collapse(full);
    }

    const exportStart = exportNode.range().start.index;
    const bodyStart = bodyNode.range().start.index;
    const head = full.slice(0, bodyStart - exportStart);
    return collapse(head);
}

/** Resolve the exported name from a declaration node. */
function nameOf(declNode: SgNode): string | undefined {
    const kind = declNode.kind();

    if (kind === "lexical_declaration" || kind === "variable_declaration") {
        const declarator = declNode.children().find((c) => c.kind() === "variable_declarator");

        if (declarator) {
            return getNodeField(declarator, "name")?.text();
        }

        return undefined;
    }

    return getNodeField(declNode, "name")?.text();
}

/**
 * Extract exported top-level symbols and their body-free signatures from a
 * source string. PURE — no I/O, no clock. Built-in TS/TSX/JS use the
 * synchronous Lang path; unknown languages return [].
 */
export function extractSymbols(source: string, language: string): ExtractedSymbol[] {
    const lang = BUILTIN_LANG[language];

    if (!lang) {
        return [];
    }

    const root = parse(lang, source).root();
    const out: ExtractedSymbol[] = [];

    for (const exportNode of root.findAll({ rule: { kind: "export_statement" } })) {
        const decl = getNodeField(exportNode, "declaration");

        if (!decl) {
            continue;
        }

        const kind = DECL_KIND_TO_SYMBOL[decl.kind()];

        if (!kind) {
            continue;
        }

        const name = nameOf(decl);

        if (!name) {
            continue;
        }

        out.push({ kind, name, signature: signatureOf(exportNode, decl) });
    }

    return out;
}

/** Resolve a filename's extension to a known language name (or null). */
export function languageForFile(ext: string): string | null {
    return EXT_TO_LANGUAGE_NAME[ext.toLowerCase()] ?? null;
}

/** True when the extension maps to a built-in (sync-parseable) language. */
export function isBuiltinLanguage(ext: string): boolean {
    return Boolean(EXT_TO_LANG[ext.toLowerCase()]);
}
