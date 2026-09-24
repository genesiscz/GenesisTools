#!/usr/bin/env bun
/**
 * A plugin file that RUNS must be standalone.
 *
 * `plugins/**` is copied out of this checkout by the harness and executed from somewhere
 * else, where the repository's tsconfig paths and `node_modules` do not exist. Measured
 * 2026-09-21 from a directory outside the repo:
 *
 *     error: Cannot find module '@genesiscz/utils/json' from '<tmp>/t.ts'
 *
 * So `@genesiscz/*` and `@app/*` are unreachable there, and an import of one is a crash at
 * the moment the hook or skill script fires, not a build error anyone sees first.
 *
 * TESTS and EVAL fixtures are exempt. They only ever run from this checkout, by `bun run
 * test`, so they may use the shared helpers. Nothing copies them anywhere that matters.
 *
 * Run: bun scripts/ci/check-plugin-standalone.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { out } from "@genesiscz/utils/logger";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");
const PLUGINS = join(ROOT, "plugins");
const REPO_ALIAS = /^(@genesiscz|@app)\//;

export interface AliasImport {
    line: number;
    specifier: string;
}

/**
 * Every import of a repo alias in `text`, with its 1-based line: static and type imports,
 * re-exports, side-effect imports, `import(...)` and `require(...)`. TypeScript's own import
 * scanner reads them, so a specifier in a string or a comment is not an import, while a biome-
 * wrapped named import (the `from "..."` on its own line) and `import(/* c *\/ "@x")` are.
 */
export function findAliasImports(text: string): AliasImport[] {
    const { importedFiles } = ts.preProcessFile(text, true, true);
    const found: AliasImport[] = [];

    for (const { fileName, pos } of importedFiles) {
        if (REPO_ALIAS.test(fileName)) {
            found.push({ line: text.slice(0, pos).split("\n").length, specifier: fileName });
        }
    }

    return found.sort((a, b) => a.line - b.line);
}

/** Only what executes from a copied plugin. A test never does. */
export function shipsAndRuns(path: string): boolean {
    if (/\.(test|spec)\.tsx?$/.test(path)) {
        return false;
    }

    return !path.split("/").includes("evals");
}

function walk(dir: string, found: string[]): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);

        if (entry === "node_modules" || entry.startsWith(".")) {
            continue;
        }

        if (statSync(path).isDirectory()) {
            walk(path, found);
            continue;
        }

        if (/\.tsx?$/.test(entry)) {
            found.push(path);
        }
    }

    return found;
}

if (import.meta.main) {
    const offenders: string[] = [];
    let scanned = 0;

    for (const path of walk(PLUGINS, [])) {
        const rel = relative(ROOT, path);

        if (!shipsAndRuns(rel)) {
            continue;
        }

        scanned += 1;

        for (const { line, specifier } of findAliasImports(readFileSync(path, "utf8"))) {
            offenders.push(`${rel}:${line}  imports ${specifier}`);
        }
    }

    if (offenders.length > 0) {
        out.log.error(`check-plugin-standalone: ${offenders.length} import(s) a copied plugin cannot resolve`);

        for (const offender of offenders) {
            out.log.error(`  ${offender}`);
        }

        out.log.info(
            "A plugin script runs outside this checkout. Inline what it needs, or move the code into a sibling"
        );
        out.log.info(
            "file under the same plugin. Bare JSON is allowed there: biome.json turns noRestrictedGlobals off."
        );
        process.exit(1);
    }

    out.log.success(`check-plugin-standalone: OK (${scanned} runnable plugin file(s), no repo-alias imports)`);
}
