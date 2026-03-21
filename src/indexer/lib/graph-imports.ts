import { Lang, parse } from "@ast-grep/napi";

export interface ImportInfo {
    /** Raw module specifier from the source code */
    specifier: string;
    /** Whether this is a dynamic import (lazy-loaded) */
    isDynamic: boolean;
}

type AstRoot = ReturnType<ReturnType<typeof parse>["root"]>;

function getLangForExtension(ext: string): Lang | null {
    const map: Record<string, Lang> = {
        ".ts": Lang.TypeScript,
        ".tsx": Lang.Tsx,
        ".js": Lang.JavaScript,
        ".jsx": Lang.JavaScript,
        ".mjs": Lang.JavaScript,
        ".cjs": Lang.JavaScript,
    };

    return map[ext] ?? null;
}

/** Extract JS/TS imports from an ast-grep root node */
function extractJsTsImports(root: AstRoot): ImportInfo[] {
    const imports: ImportInfo[] = [];

    // import ... from "..."
    for (const node of root.findAll({ rule: { kind: "import_statement" } })) {
        const sourceNode = node.find({ rule: { kind: "string" } });

        if (sourceNode) {
            const spec = sourceNode.text().replace(/['"]/g, "");
            imports.push({ specifier: spec, isDynamic: false });
        }
    }

    // require("...") and dynamic import("...")
    for (const node of root.findAll({ rule: { kind: "call_expression" } })) {
        const text = node.text();

        const requireMatch = text.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);

        if (requireMatch) {
            imports.push({ specifier: requireMatch[1], isDynamic: false });
            continue;
        }

        const dynamicMatch = text.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);

        if (dynamicMatch) {
            imports.push({ specifier: dynamicMatch[1], isDynamic: true });
        }
    }

    // export ... from "..."
    for (const node of root.findAll({ rule: { kind: "export_statement" } })) {
        const sourceNode = node.find({ rule: { kind: "string" } });

        if (sourceNode) {
            const spec = sourceNode.text().replace(/['"]/g, "");
            imports.push({ specifier: spec, isDynamic: false });
        }
    }

    return imports;
}

/** Extract Python imports via regex */
function extractPythonImports(source: string): ImportInfo[] {
    const imports: ImportInfo[] = [];

    // import foo / import foo.bar
    for (const match of source.matchAll(/^import\s+(\S+)/gm)) {
        const mod = match[1].split(/\s+as\s+/)[0].trim();

        if (mod) {
            imports.push({ specifier: mod, isDynamic: false });
        }
    }

    // from foo import bar
    for (const match of source.matchAll(/^from\s+(\S+)\s+import/gm)) {
        imports.push({ specifier: match[1], isDynamic: false });
    }

    return imports;
}

/** Extract Go imports via regex */
function extractGoImports(source: string): ImportInfo[] {
    const imports: ImportInfo[] = [];

    // Single import: import "fmt"
    for (const match of source.matchAll(/^import\s+"([^"]+)"/gm)) {
        const spec = match[1];

        // Skip stdlib (no dot in path typically means stdlib)
        if (spec.includes(".")) {
            imports.push({ specifier: spec, isDynamic: false });
        }
    }

    // Grouped imports: import ( "fmt" \n "os" )
    for (const match of source.matchAll(/import\s*\(([\s\S]*?)\)/gm)) {
        const block = match[1];

        for (const lineMatch of block.matchAll(/"([^"]+)"/g)) {
            const spec = lineMatch[1];

            if (spec.includes(".")) {
                imports.push({ specifier: spec, isDynamic: false });
            }
        }
    }

    return imports;
}

/**
 * Detect language from file extension.
 * Returns null for unsupported languages.
 */
function detectLanguage(ext: string): "typescript" | "python" | "go" | null {
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
        return "typescript";
    }

    if (ext === ".py") {
        return "python";
    }

    if (ext === ".go") {
        return "go";
    }

    return null;
}

/**
 * Extract import statements from source code.
 * Supports: TypeScript/JavaScript, Python, Go.
 */
export function extractImports(source: string, language: string): ImportInfo[] {
    switch (language) {
        case "typescript":
        case "javascript": {
            // Determine which Lang to use based on content heuristics
            // Default to TypeScript since it's a superset of JS
            try {
                const lang = Lang.TypeScript;
                const root = parse(lang, source).root();
                return extractJsTsImports(root);
            } catch {
                return [];
            }
        }

        case "tsx": {
            try {
                const root = parse(Lang.Tsx, source).root();
                return extractJsTsImports(root);
            } catch {
                return [];
            }
        }

        case "python":
            return extractPythonImports(source);

        case "go":
            return extractGoImports(source);

        default:
            return [];
    }
}

/**
 * Get the language string from a file extension.
 * Used by buildCodeGraph to determine which extraction mode to use.
 */
export function getLanguageFromExtension(ext: string): string | null {
    const lang = detectLanguage(ext);

    if (lang) {
        return lang;
    }

    const astLang = getLangForExtension(ext);

    if (astLang === Lang.Tsx) {
        return "tsx";
    }

    return lang;
}
