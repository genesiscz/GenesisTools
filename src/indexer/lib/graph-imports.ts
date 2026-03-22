import { createRequire } from "node:module";
import { Lang, parse, registerDynamicLanguage } from "@ast-grep/napi";

export interface ImportInfo {
    /** Raw module specifier from the source code */
    specifier: string;
    /** Whether this is a dynamic import (lazy-loaded) */
    isDynamic: boolean;
}

type AstRoot = ReturnType<ReturnType<typeof parse>["root"]>;

// --- Dynamic language registration ---

const esmRequire = createRequire(import.meta.url);

let dynamicLangsRegistered = false;

function ensureDynamicLanguages(): void {
    if (dynamicLangsRegistered) {
        return;
    }

    dynamicLangsRegistered = true;

    const langPackages: Array<[string, string]> = [
        ["python", "@ast-grep/lang-python"],
        ["go", "@ast-grep/lang-go"],
        ["rust", "@ast-grep/lang-rust"],
        ["java", "@ast-grep/lang-java"],
        ["c", "@ast-grep/lang-c"],
        ["cpp", "@ast-grep/lang-cpp"],
        ["ruby", "@ast-grep/lang-ruby"],
        ["php", "@ast-grep/lang-php"],
        ["swift", "@ast-grep/lang-swift"],
        ["kotlin", "@ast-grep/lang-kotlin"],
        ["scala", "@ast-grep/lang-scala"],
        ["csharp", "@ast-grep/lang-csharp"],
    ];

    const modules: Record<string, { libraryPath: string; extensions: string[]; languageSymbol?: string }> = {};

    for (const [name, pkg] of langPackages) {
        try {
            modules[name] = esmRequire(pkg);
        } catch {
            // Grammar not installed — skip
        }
    }

    if (Object.keys(modules).length > 0) {
        registerDynamicLanguage(modules);
    }
}

// --- JS/TS extractor ---

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
        const funcNode = node.child(0);
        const funcName = funcNode?.text();

        if (funcName === "require") {
            const args = node.find({ rule: { kind: "string" } });

            if (args) {
                const spec = args.text().replace(/['"]/g, "");
                imports.push({ specifier: spec, isDynamic: false });
            }

            continue;
        }

        if (funcName === "import") {
            const args = node.find({ rule: { kind: "string" } });

            if (args) {
                const spec = args.text().replace(/['"]/g, "");
                imports.push({ specifier: spec, isDynamic: true });
            }
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

// --- Python extractor (AST) ---

/** Extract Python imports via ast-grep AST parsing */
function extractPythonImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("python" as Lang, source).root();

        // import foo / import foo, bar / import foo as f
        for (const node of root.findAll({ rule: { kind: "import_statement" } })) {
            const text = node.text();
            const match = text.match(/^import\s+(.+)/);

            if (match) {
                for (const mod of match[1].split(",")) {
                    const cleaned = mod
                        .trim()
                        .split(/\s+as\s+/)[0]
                        .trim();

                    if (cleaned) {
                        imports.push({ specifier: cleaned, isDynamic: false });
                    }
                }
            }
        }

        // from foo import bar / from . import utils
        for (const node of root.findAll({ rule: { kind: "import_from_statement" } })) {
            const text = node.text();
            const match = text.match(/^from\s+(\S+)\s+import/);

            if (match) {
                imports.push({ specifier: match[1], isDynamic: false });
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- Go extractor (AST) ---

/** Extract Go imports via ast-grep AST parsing */
function extractGoImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("go" as Lang, source).root();

        // Each import_spec contains the actual import path
        // Works for both single imports and grouped import blocks
        for (const node of root.findAll({ rule: { kind: "import_spec" } })) {
            const pathNode = node.find({ rule: { kind: "interpreted_string_literal" } });

            if (pathNode) {
                const spec = pathNode.text().replace(/"/g, "");
                imports.push({ specifier: spec, isDynamic: false });
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- Java extractor (AST) ---

/** Extract Java imports via ast-grep AST parsing */
function extractJavaImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("java" as Lang, source).root();

        for (const node of root.findAll({ rule: { kind: "import_declaration" } })) {
            const text = node.text();
            const match = text.match(/^import\s+(?:static\s+)?([^;]+)/);

            if (match) {
                imports.push({ specifier: match[1].trim(), isDynamic: false });
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- Rust extractor (AST) ---

/** Extract Rust imports via ast-grep AST parsing */
function extractRustImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("rust" as Lang, source).root();

        // use std::collections::HashMap;
        for (const node of root.findAll({ rule: { kind: "use_declaration" } })) {
            const text = node.text();
            const match = text.match(/^use\s+(.+);?\s*$/);

            if (match) {
                imports.push({ specifier: match[1].trim().replace(/;$/, ""), isDynamic: false });
            }
        }

        // mod foo; (external file reference, not inline mod { ... })
        for (const node of root.findAll({ rule: { kind: "mod_item" } })) {
            const text = node.text();

            if (text.includes("{")) {
                continue;
            }

            const match = text.match(/^mod\s+(\w+)\s*;/);

            if (match) {
                imports.push({ specifier: match[1], isDynamic: false });
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- C/C++ extractor (AST) ---

/** Extract C/C++ #include directives via ast-grep AST parsing */
function extractCCppIncludes(source: string, lang: "c" | "cpp"): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse(lang as Lang, source).root();

        for (const node of root.findAll({ rule: { kind: "preproc_include" } })) {
            const text = node.text();
            // Only track local includes (quoted), not system includes (angle brackets)
            const localMatch = text.match(/#include\s+"([^"]+)"/);

            if (localMatch) {
                imports.push({ specifier: localMatch[1], isDynamic: false });
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- Ruby extractor (AST) ---

/** Extract Ruby require/require_relative via ast-grep AST parsing */
function extractRubyImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("ruby" as Lang, source).root();

        for (const node of root.findAll({ rule: { kind: "call" } })) {
            const text = node.text();
            const reqMatch = text.match(/^require(?:_relative)?\s*[(]?\s*['"]([^'"]+)['"]/);

            if (reqMatch) {
                imports.push({
                    specifier: reqMatch[1],
                    isDynamic: false,
                });
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- Swift extractor (AST) ---

/** Extract Swift imports via ast-grep AST parsing */
function extractSwiftImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("swift" as Lang, source).root();

        for (const node of root.findAll({ rule: { kind: "import_declaration" } })) {
            const text = node.text();
            const match = text.match(/^import\s+(.+)/);

            if (match) {
                imports.push({ specifier: match[1].trim(), isDynamic: false });
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- PHP extractor (AST) ---

/** Extract PHP use/require/include via ast-grep AST parsing */
function extractPhpImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("php" as Lang, source).root();

        // use App\Models\User; / use App\Models\{User, Post};
        for (const node of root.findAll({ rule: { kind: "namespace_use_declaration" } })) {
            const text = node.text();

            // Grouped use: use App\Models\{User, Post};
            const groupMatch = text.match(/^use\s+(?:function\s+|const\s+)?([\w\\]+)\\\{([^}]+)\}/);

            if (groupMatch) {
                const prefix = groupMatch[1];
                const members = groupMatch[2].split(",");

                for (const member of members) {
                    const name = member
                        .trim()
                        .split(/\s+as\s+/)[0]
                        .trim();

                    if (name) {
                        imports.push({ specifier: `${prefix}\\${name}`, isDynamic: false });
                    }
                }

                continue;
            }

            // Single use: use App\Models\User; or use App\Models\User as Alias;
            const singleMatch = text.match(/^use\s+(?:function\s+|const\s+)?([\w\\]+)/);

            if (singleMatch) {
                imports.push({ specifier: singleMatch[1].trim(), isDynamic: false });
            }
        }

        // require/require_once/include/include_once
        for (const node of root.findAll({ rule: { kind: "expression_statement" } })) {
            const text = node.text();
            const match = text.match(/(?:require|include)(?:_once)?\s*[(]?\s*['"]([^'"]+)['"]/);

            if (match) {
                imports.push({ specifier: match[1], isDynamic: false });
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- Kotlin extractor (AST) ---

/** Extract Kotlin imports via ast-grep AST parsing */
function extractKotlinImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("kotlin" as Lang, source).root();

        for (const node of root.findAll({ rule: { kind: "import_header" } })) {
            const text = node.text();
            const match = text.match(/^import\s+(.+)/);

            if (match) {
                const spec = match[1]
                    .trim()
                    .split(/\s+as\s+/)[0]
                    .trim();

                if (spec) {
                    imports.push({ specifier: spec, isDynamic: false });
                }
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- Scala extractor (AST) ---

/** Extract Scala imports via ast-grep AST parsing */
function extractScalaImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("scala" as Lang, source).root();

        for (const node of root.findAll({ rule: { kind: "import_declaration" } })) {
            const text = node.text();
            const match = text.match(/^import\s+(.+)/);

            if (match) {
                const importBody = match[1].trim();
                const groupMatch = importBody.match(/^([^{]+)\{([^}]+)\}/);

                if (groupMatch) {
                    const prefix = groupMatch[1];

                    for (const member of groupMatch[2].split(",")) {
                        const name = member.trim().split(/\s+/)[0].trim();

                        if (name) {
                            imports.push({ specifier: prefix + name, isDynamic: false });
                        }
                    }
                } else {
                    const spec = importBody
                        .split(/\s*[{,]/)
                        .filter(Boolean)[0]
                        ?.trim();

                    if (spec) {
                        imports.push({ specifier: spec, isDynamic: false });
                    }
                }
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- C# extractor (AST) ---

/** Extract C# using directives via ast-grep AST parsing */
function extractCSharpImports(source: string): ImportInfo[] {
    ensureDynamicLanguages();
    const imports: ImportInfo[] = [];

    try {
        const root = parse("csharp" as Lang, source).root();

        for (const node of root.findAll({ rule: { kind: "using_directive" } })) {
            const text = node.text();
            const match = text.match(/^using\s+(?:static\s+)?([^;]+)/);

            if (match) {
                const body = match[1].trim();
                // Handle aliased using: "MyAlias = System.Text" → extract "System.Text"
                const spec = body.includes("=") ? body.split("=").pop()!.trim() : body.split(/\s+/)[0].trim();

                if (spec && spec !== "var") {
                    imports.push({ specifier: spec, isDynamic: false });
                }
            }
        }
    } catch {
        return [];
    }

    return imports;
}

// --- Central dispatcher ---

/**
 * Extract import statements from source code.
 * Supports: TypeScript/JavaScript, TSX/JSX, Python, Go, Java, Rust, C, C++,
 * Ruby, Swift, PHP, Kotlin, Scala, C#.
 */
export function extractImports(source: string, language: string): ImportInfo[] {
    switch (language) {
        case "typescript":
        case "javascript": {
            try {
                const root = parse(Lang.TypeScript, source).root();
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

        case "java":
            return extractJavaImports(source);

        case "rust":
            return extractRustImports(source);

        case "c":
            return extractCCppIncludes(source, "c");

        case "cpp":
            return extractCCppIncludes(source, "cpp");

        case "ruby":
            return extractRubyImports(source);

        case "swift":
            return extractSwiftImports(source);

        case "php":
            return extractPhpImports(source);

        case "kotlin":
            return extractKotlinImports(source);

        case "scala":
            return extractScalaImports(source);

        case "csharp":
            return extractCSharpImports(source);

        default:
            return [];
    }
}
