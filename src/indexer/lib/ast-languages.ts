import { createRequire } from "node:module";
import { registerDynamicLanguage } from "@ast-grep/napi";

const esmRequire = createRequire(import.meta.url);

let dynamicLangsRegistered = false;

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

/** Register dynamic language grammars. Safe to call multiple times. */
export function ensureDynamicLanguages(): void {
    if (dynamicLangsRegistered) {
        return;
    }

    dynamicLangsRegistered = true;

    const modules: Record<string, { libraryPath: string; extensions: string[]; languageSymbol?: string }> = {};

    for (const [name, pkg] of DYNAMIC_LANG_PACKAGES) {
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
