#!/usr/bin/env bun
/**
 * Package-boundary guard for @genesiscz/utils + @genesiscz/tools (flat design,
 * supersedes the layered @gt/* catalog from MONOREPO-SPEC.md).
 *
 * @genesiscz/utils is a single Bun workspace package living physically at
 * src/utils/ (package.json + tsconfig.json + exports there). Since the
 * 2026-07-18 cutover every import of it uses the package name
 * (`@genesiscz/utils/...`); the legacy `@app/utils/...` alias still resolves
 * via the root tsconfig's `@app/*` catch-all but is banned (rule 2) so it
 * cannot creep back in.
 *
 * RULES:
 *  1. FAIL — @genesiscz/utils purity: NO file under src/utils/** may import
 *     `@app/*` (tool internals). Utils modules import siblings via
 *     `@genesiscz/utils/*` (or relative) and third-party node_modules only.
 *  2. FAIL — legacy alias: no file anywhere (src/, scripts/, root tools
 *     dispatcher) may use an `@app/utils…` specifier — rewrite to
 *     `@genesiscz/utils…` (re-run scripts/codemods/2026-07-18-genesiscz-cutover.ts).
 *     scripts/codemods/ is exempt: frozen move tables mention historic specs.
 *  3. WARN — tool -> tool: src/<tool> importing another tool's internals
 *     (@app/<otherTool>/*). Known backlog; flips to FAIL in a later phase.
 *
 * Run: `bun scripts/ci/check-package-boundaries.ts`
 */
import { $ } from "bun";

/** A `@app/<seg>` import — returns the first segment (tool name or shared prefix). */
const TOOL_IMPORT_RE = /@app\/([a-zA-Z0-9._-]+)(?:\/|"|')/;

/** src/ subtrees that are shared infra, not tools (tool->tool rule ignores them as targets). */
const SHARED_SRC_PREFIXES = ["utils", "ask"];

interface ImportHit {
    file: string;
    line: number;
    spec: string;
}

/** rg every `from "<spec>"` / bare `import "<spec>"` across scopes, excluding node_modules. */
async function collectImports(scopes: string[]): Promise<ImportHit[]> {
    // NOTE: glob patterns are interpolated as variables so Bun's `$` quotes
    // them — passing bare `-g *.ts` lets the embedded shell glob-expand `*.ts`
    // (to nothing) before rg ever sees it, silently dropping every match.
    const excludeNodeModules = "!node_modules";
    const excludeCodemods = "!scripts/codemods";
    const globTs = "*.ts";
    const globTsx = "*.tsx";
    const pattern = "(?:from\\s+[\"']([^\"']+)[\"']|^\\s*import\\s+[\"']([^\"']+)[\"'])";
    const raw =
        await $`rg -n --no-heading -g ${excludeNodeModules} -g ${excludeCodemods} -g ${globTs} -g ${globTsx} ${pattern} ${scopes}`
            .nothrow()
            .text();
    const hits: ImportHit[] = [];
    for (const rawLine of raw.split("\n")) {
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }

        const m = line.match(/^([^:]+):(\d+):(.*)$/);
        if (!m) {
            continue;
        }

        const [, file, lineNo, rest] = m;
        // Match `from "spec"` first, then fall back to bare side-effect `import "spec"`.
        const specMatch = rest.match(/from\s+["']([^"']+)["']/) ?? rest.match(/^\s*import\s+["']([^"']+)["']/);
        if (!specMatch) {
            continue;
        }

        hits.push({ file, line: Number(lineNo), spec: specMatch[1] });
    }

    return hits;
}

function appSegmentOf(spec: string): string | null {
    const m = spec.match(TOOL_IMPORT_RE);
    return m ? m[1] : null;
}

const hardErrors: string[] = [];
const warnings: string[] = [];

// `tools` (root dispatcher) has no .ts extension; rg searches explicitly-named
// files regardless of -g type globs, so listing it here works.
const allHits = await collectImports(["src", "scripts", "tools"]);

for (const hit of allHits) {
    // ---- rule 2 (FAIL): legacy @app/utils alias anywhere ----
    if (/^@app\/utils(?:$|[/.])/.test(hit.spec)) {
        hardErrors.push(
            `${hit.file}:${hit.line}  legacy @app/utils alias — use @genesiscz/utils (cutover codemod): ${hit.spec}`
        );
        continue;
    }

    // ---- rule 1b (FAIL): @ask/* aliases src/ask/* (tool internals) — same impurity as @app/*.
    if (hit.file.startsWith("src/utils/") && hit.spec.startsWith("@ask/")) {
        hardErrors.push(`${hit.file}:${hit.line}  @genesiscz/utils must not import @ask/* (impurity): ${hit.spec}`);
        continue;
    }

    const appTarget = appSegmentOf(hit.spec);
    if (appTarget === null) {
        continue;
    }

    // ---- rule 1 (FAIL): @genesiscz/utils purity ----
    if (hit.file.startsWith("src/utils/")) {
        hardErrors.push(`${hit.file}:${hit.line}  @genesiscz/utils must not import @app/* (impurity): ${hit.spec}`);
        continue;
    }

    // ---- rule 3 (WARN): tool -> another tool's internals ----
    const fromToolMatch = hit.file.match(/^src\/([^/]+)\//);
    const fromTool = fromToolMatch ? fromToolMatch[1] : null;
    const fromIsShared = fromTool !== null && SHARED_SRC_PREFIXES.includes(fromTool);
    if (!fromIsShared && fromTool !== null && !SHARED_SRC_PREFIXES.includes(appTarget) && appTarget !== fromTool) {
        warnings.push(
            `${hit.file}:${hit.line}  tool src/${fromTool} -> other tool @app/${appTarget}/* (cutover backlog): ${hit.spec}`
        );
    }
}

if (warnings.length > 0) {
    console.warn(
        `⚠ ${warnings.length} boundary warnings (known backlog — flip to FAIL per follow-up phase; SPEC §0.3/§5):`
    );
    const sample = warnings.slice(0, 15);
    for (const w of sample) {
        console.warn(`  ${w}`);
    }

    if (warnings.length > sample.length) {
        console.warn(`  …and ${warnings.length - sample.length} more`);
    }
}

if (hardErrors.length > 0) {
    console.error(`✖ ${hardErrors.length} HARD boundary violations:`);
    for (const e of hardErrors.slice(0, 40)) {
        console.error(`  ${e}`);
    }

    if (hardErrors.length > 40) {
        console.error(`  …and ${hardErrors.length - 40} more`);
    }

    process.exit(1);
}

console.log(
    `✓ package boundaries clean (@genesiscz/utils pure, no legacy @app/utils); ${warnings.length} known-backlog warnings`
);
