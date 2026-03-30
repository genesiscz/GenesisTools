import { createRequire } from "node:module";
import { Lang, registerDynamicLanguage } from "@ast-grep/napi";
import { ensurePackages, isPackageInstalled } from "@app/utils/packages";

const esmRequire = createRequire(import.meta.url);

// ─── Extension → language mapping tables ────────────────────────

/** Extension -> ast-grep built-in Lang (for parse()) */
export const EXT_TO_LANG: Record<string, Lang> = {
    ".ts": Lang.TypeScript,
    ".tsx": Lang.Tsx,
    ".js": Lang.JavaScript,
    ".jsx": Lang.Tsx,
    ".mjs": Lang.JavaScript,
    ".cjs": Lang.JavaScript,
    ".mts": Lang.TypeScript,
    ".cts": Lang.TypeScript,
    ".html": Lang.Html,
    ".htm": Lang.Html,
    ".css": Lang.Css,
};

/** Extension -> human-readable language name (used for chunk metadata and graph) */
export const EXT_TO_LANGUAGE_NAME: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".md": "markdown",
    ".json": "json",
    ".py": "python",
    ".pyw": "python",
    ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cc": "cpp",
    ".hh": "cpp",
    ".cxx": "cpp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".scala": "scala",
    ".cs": "csharp",
};

const DYNAMIC_LANG_PACKAGES: Array<[string, string]> = [
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

// ─── Derived mapping tables ────────────────────────────────────

const DYNAMIC_LANG_NAMES = new Set(DYNAMIC_LANG_PACKAGES.map(([name]) => name));

/** Extension -> dynamic language string identifier (derived from EXT_TO_LANGUAGE_NAME + DYNAMIC_LANG_PACKAGES) */
export const EXT_TO_DYNAMIC_LANG: Record<string, string> = Object.fromEntries(
    Object.entries(EXT_TO_LANGUAGE_NAME).filter(([, lang]) => DYNAMIC_LANG_NAMES.has(lang))
);

/** Language name -> known extensions (derived from EXT_TO_LANGUAGE_NAME) */
export const LANGUAGE_EXTENSIONS: Record<string, string[]> = {};

for (const [ext, lang] of Object.entries(EXT_TO_LANGUAGE_NAME)) {
    if (!LANGUAGE_EXTENSIONS[lang]) {
        LANGUAGE_EXTENSIONS[lang] = [];
    }

    LANGUAGE_EXTENSIONS[lang].push(ext);
}

/** Get language name from file extension (returns null for unknown) */
export function getLanguageForExt(ext: string): string | null {
    return EXT_TO_LANGUAGE_NAME[ext.toLowerCase()] ?? null;
}

let dynamicLangsRegistered = false;

/** Register dynamic language grammars, installing missing ones on-demand. Safe to call multiple times. */
export async function ensureDynamicLanguages(options?: {
    only?: string[]; // Only install these languages (e.g. ["python", "go"])
}): Promise<void> {
    if (dynamicLangsRegistered && !options?.only) {
        return;
    }

    if (!options?.only) {
        dynamicLangsRegistered = true;
    }

    const targetLangs = options?.only
        ? DYNAMIC_LANG_PACKAGES.filter(([name]) => options.only!.includes(name))
        : DYNAMIC_LANG_PACKAGES;

    const missing = targetLangs
        .filter(([, pkg]) => !isPackageInstalled(pkg))
        .map(([, pkg]) => pkg);

    if (missing.length > 0) {
        await ensurePackages(missing, {
            label: `AST grammars (${missing.length} language${missing.length > 1 ? "s" : ""})`,
            interactive: true,
            reason: "Enables code parsing for syntax-aware indexing and search",
        });
    }

    const modules: Record<string, { libraryPath: string; extensions: string[]; languageSymbol?: string }> = {};

    for (const [name, pkg] of targetLangs) {
        try {
            modules[name] = esmRequire(pkg);
        } catch {
            // Still missing after install attempt — skip
        }
    }

    if (Object.keys(modules).length > 0) {
        registerDynamicLanguage(modules);
    }
}
