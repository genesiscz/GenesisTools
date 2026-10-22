import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The folder of the module that passes its `import.meta`. Bun sets `import.meta.dir`; Vite's SSR module runner and
 * Node do not, so a module-level `join(import.meta.dir, …)` threw there and broke every dashboard that imported it
 * (`tools clarity ui` answered 500, 2026-10-22). `import.meta.url` is a file URL in all three.
 */
export function moduleDir(meta: ImportMeta): string {
    return typeof meta.dir === "string" ? meta.dir : dirname(fileURLToPath(meta.url));
}

/**
 * Loads a module beside the caller by a path built at run time, so neither a bundler nor the type checker follows it.
 * Uses `require` where the runtime injects it (a Bun module) and `createRequire` elsewhere (Vite's SSR runner has no
 * `require`). Throws like `require` when the file is missing or does not load; callers treat that as "not here".
 */
export function requireSibling(meta: ImportMeta, name: string): unknown {
    const path = join(moduleDir(meta), name);
    const load = typeof require === "function" ? require : createRequire(meta.url);
    return load(path);
}
