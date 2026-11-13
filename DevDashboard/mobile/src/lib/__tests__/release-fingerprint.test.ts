import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { RELEASE_JS_INPUTS } from "../../../e2e/adapter";

const APP_DIR = resolve(import.meta.dir, "../../..");
const REPO_DIR = resolve(APP_DIR, "../..");

/** The `match` aliases of metro.config.js: an exact specifier and the file it bundles. */
function metroMatches(): Map<string, string> {
    const config = readFileSync(join(APP_DIR, "metro.config.js"), "utf8");
    const rules = new Map<string, string>();
    const rule = /match:\s*"([^"]+)",\s*target:\s*path\.resolve\((projectRoot|workspaceRoot),\s*"([^"]+)"\)/g;

    for (const [, specifier, root, target] of config.matchAll(rule)) {
        rules.set(specifier, join(root === "projectRoot" ? APP_DIR : REPO_DIR, target));
    }

    return rules;
}

const METRO = metroMatches();

/** A specifier as Metro resolves it (metro.config.js), or null for a package from node_modules. */
function target(specifier: string, from: string): string | null {
    const exact = METRO.get(specifier);

    if (exact) {
        return exact;
    }

    const prefixes: Array<[string, string]> = [
        ["@dd/", join(REPO_DIR, "src/dev-dashboard")],
        ["@/", join(APP_DIR, "src")],
        ["@app/", join(REPO_DIR, "src")],
    ];

    for (const [prefix, dir] of prefixes) {
        if (specifier.startsWith(prefix)) {
            return join(dir, specifier.slice(prefix.length));
        }
    }

    return specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
}

function file(path: string): string | null {
    for (const candidate of [path, `${path}.ts`, `${path}.tsx`, `${path}.js`, join(path, "index.ts"), join(path, "index.tsx")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return null;
}

/** The specifiers a file imports at run time; `import type` and imports of types only are erased from the bundle. */
function valueImports(source: string): string[] {
    const specifiers: string[] = [];
    const statement = /^\s*(?:import|export)\s+(?!type\s)([^;]*?)\s+from\s+"([^"]+)"/gm;

    for (const [, clause, specifier] of source.matchAll(statement)) {
        const names = /^\{([^}]*)\}$/.exec(clause.trim())?.[1];
        const typesOnly = names !== undefined && names.split(",").every((name) => /^\s*(type\s|$)/.test(name));

        if (!typesOnly) {
            specifiers.push(specifier);
        }
    }

    for (const [, specifier] of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
        specifiers.push(specifier);
    }

    return specifiers;
}

/** Every file the app bundle reaches from its own sources, followed through the aliases Metro uses. */
function bundledFiles(): string[] {
    const entries = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: APP_DIR })]
        .filter((path) => !/\.test\.tsx?$|__tests__/.test(path))
        .map((path) => join(APP_DIR, path));
    const seen = new Set(entries);
    const queue = [...entries];

    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (!/\.(ts|tsx|js)$/.test(next)) {
            continue;
        }

        for (const specifier of valueImports(readFileSync(next, "utf8"))) {
            const path = target(specifier, next);
            const found = path ? file(path) : null;

            if (found && !found.includes("/node_modules/") && !seen.has(found)) {
                seen.add(found);
                queue.push(found);
            }
        }
    }

    return [...seen].map((path) => relative(APP_DIR, path));
}

describe("the Release fingerprint", () => {
    it("covers every file Metro bundles, inside the app folder and outside it", () => {
        const files = bundledFiles();
        const globs = RELEASE_JS_INPUTS.map((pattern) => new Bun.Glob(pattern));
        const missing = files.filter((path) => !globs.some((glob) => glob.match(path)));

        expect(files).toContain("src/global.css");
        expect(files).toContain("../../src/dev-dashboard/contract/client.ts");
        expect(missing).toEqual([]);
    });
});
