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

/** Find every `from "<spec>"`, bare `import "<spec>"`, dynamic `import("<spec>")`, and `require("<spec>")` across scopes. */
async function collectImports(scopes: string[]): Promise<ImportHit[]> {
    // Uses `git grep`, not `rg`. The GitHub ubuntu runner has no ripgrep, and
    // this call used `.nothrow().text()` — so a missing binary returned an
    // empty string, `hits` came back empty, and the guard printed
    // "package boundaries clean" having scanned nothing. Verified: with `rg`
    // stubbed to exit 127 the guard reported 0 warnings and exit 0, against 313
    // warnings when it runs. That is the same silent pass the sibling guards
    // were converted away from; see scripts/ci/require-grep.sh.
    //
    // `git grep` also searches tracked files only, which is what a boundary
    // guard wants, so the node_modules exclusion is no longer needed.
    const pattern =
        "(?:from\\s+[\"']([^\"']+)[\"']|^\\s*import\\s+[\"']([^\"']+)[\"']|import\\s*\\(\\s*[\"']([^\"']+)[\"']|require\\s*\\(\\s*[\"']([^\"']+)[\"'])";
    // Pathspecs are OR'd, not AND'd, so the extension filter cannot live here —
    // `-- src "*.ts"` means "under src OR ending in .ts" and pulled in .md docs.
    // It is applied per hit below instead.
    const result = await $`git grep -nP -e ${pattern} -- ${scopes} ":(exclude)scripts/codemods"`.nothrow().quiet();

    // 0 = matches, 1 = no matches. Anything else means the scan did not run,
    // and a scan that did not run must never be reported as a clean one.
    if (result.exitCode > 1) {
        console.error(
            `::error:: \`git grep\` failed (exit ${result.exitCode}) while scanning imports — refusing to report a clean result from a scan that did not run.`
        );
        console.error(result.stderr.toString().trim());
        process.exit(1);
    }

    const raw = result.stdout.toString();
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
        // `tools` is the extensionless root dispatcher, and rule 2 names it
        // explicitly, so it must survive the extension filter.
        if (!file.endsWith(".ts") && !file.endsWith(".tsx") && file !== "tools") {
            continue;
        }

        // Static `from "spec"` first, then side-effect `import "spec"`, then
        // dynamic `import("spec")` / `require("spec")` — the dynamic forms are
        // exactly how the @ask leak in ai/resolvers dodged the first version
        // of this guard.
        const specMatch =
            rest.match(/from\s+["']([^"']+)["']/) ??
            rest.match(/^\s*import\s+["']([^"']+)["']/) ??
            rest.match(/import\s*\(\s*["']([^"']+)["']/) ??
            rest.match(/require\s*\(\s*["']([^"']+)["']/);
        if (!specMatch) {
            continue;
        }

        hits.push({ file, line: Number(lineNo), spec: specMatch[1] });
    }

    return hits;
}

/**
 * Deliberate, documented cross-boundary escape hatches (dynamic imports with a
 * graceful standalone fallback). Keyed `file -> spec`. Keep this list SHORT.
 */
const PURITY_EXEMPTIONS = new Map<string, string>([]);

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
        if (PURITY_EXEMPTIONS.get(hit.file) === hit.spec) {
            continue;
        }

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
