import { createRequire } from "node:module";
import { ensurePackages, isPackageInstalled } from "@app/utils/packages";
import { Lang, registerDynamicLanguage } from "@ast-grep/napi";

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

export const DYNAMIC_LANG_NAMES = new Set(DYNAMIC_LANG_PACKAGES.map(([name]) => name));

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

// `registerDynamicLanguage` from @ast-grep/napi is documented as "should be
// called exactly once in the program". A second call silently fails to add
// new languages (the new ones aren't queryable). We therefore aggregate every
// caller's request and run a single registration with the union of installed
// packages. Subsequent calls become no-ops.
let dynamicLangsInitPromise: Promise<void> | null = null;
let dynamicLangsRegistered = false;

async function loadAndRegisterAllInstalled(only?: Set<string>): Promise<void> {
    // Optionally prompt-install requested-but-missing packages. We never
    // install everything implicitly — only the languages someone actually
    // asked for via `only` since the program started.
    if (only && only.size > 0) {
        const missing = DYNAMIC_LANG_PACKAGES.filter(
            ([name, pkg]) => only.has(name) && !isPackageInstalled(pkg)
        ).map(([, pkg]) => pkg);

        if (missing.length > 0) {
            await ensurePackages(missing, {
                label: `AST grammars (${missing.length} language${missing.length > 1 ? "s" : ""})`,
                interactive: true,
                reason: "Enables code parsing for syntax-aware indexing and search",
            });
        }
    }

    // Register every installed package in one shot — including ones we've
    // never been asked for. Loading every grammar costs a few MB of RSS and
    // pays for itself by making subsequent ensureDynamicLanguages() calls
    // free, regardless of which language asks next.
    const modules: Record<string, { libraryPath: string; extensions: string[]; languageSymbol?: string }> = {};

    for (const [name, pkg] of DYNAMIC_LANG_PACKAGES) {
        if (!isPackageInstalled(pkg)) {
            continue;
        }

        try {
            modules[name] = esmRequire(pkg);
        } catch {
            // Skip — broken install
        }
    }

    if (Object.keys(modules).length > 0) {
        registerDynamicLanguage(modules);
    }
}

/**
 * Register dynamic language grammars, installing missing ones on-demand. Safe
 * to call multiple times — only the FIRST call performs registration. If a
 * later call asks for a language that wasn't installed at first-call time, we
 * cannot add it (ast-grep's API is single-shot), so we no-op.
 */
export async function ensureDynamicLanguages(options?: {
    only?: string[]; // Only install these languages (e.g. ["python", "go"])
}): Promise<void> {
    if (dynamicLangsRegistered) {
        return;
    }

    if (dynamicLangsInitPromise) {
        await dynamicLangsInitPromise;
        return;
    }

    dynamicLangsInitPromise = (async () => {
        await loadAndRegisterAllInstalled(options?.only ? new Set(options.only) : undefined);
        dynamicLangsRegistered = true;
    })().finally(() => {
        dynamicLangsInitPromise = null;
    });

    await dynamicLangsInitPromise;
}
