#!/usr/bin/env bun
/**
 * Package-boundary guard for @genesiscz/utils + @genesiscz/tools (flat design,
 * supersedes the layered @gt/* catalog from MONOREPO-SPEC.md).
 *
 * @genesiscz/utils is a single Bun workspace package living physically at
 * src/utils/ (package.json + tsconfig.json + exports there), alongside ~30
 * still-unmigrated legacy domains (ai/, macos/, cmux/, ui/, ...) that keep
 * importing tool internals — that's the known §0.3 backlog, unaffected by
 * this guard's rule 1.
 *
 * RULES:
 *  1. FAIL — @genesiscz/utils purity: a MIGRATED file (see UTILS_MIGRATED_FILES
 *     below) may import only sibling utils modules or third-party node_modules.
 *     ANY @app/* import is a hard error. Only migrated files are checked —
 *     unmigrated legacy domains under src/utils/** are covered by rule 4 (warn)
 *     instead, same as any other src/ file, until they're added to the list.
 *  2. WARN — known reverse-dep backlog (SPEC §0.3): src/utils/* (including
 *     unmigrated domains) importing @app/<tool>/* (log-viewer -> task/
 *     debugging-master, ui/components/youtube -> youtube, cmux <-> cmux,
 *     github -> github, notifications -> telegram-bot, ai/tasks -> tools).
 *     Each flips to FAIL as its file is added to UTILS_MIGRATED_FILES.
 *  3. WARN — tool -> tool: src/<tool> importing another tool's internals
 *     (@app/<otherTool>/*). Flips to FAIL in the cutover phase.
 *
 * Run: `bun scripts/ci/check-package-boundaries.ts`
 */
import { $ } from "bun";

/**
 * Files physically in src/utils/ that are part of the @genesiscz/utils
 * package contract today (i.e. listed in src/utils/package.json#exports, plus
 * their colocated *.test.ts). Purity (rule 1) applies ONLY to these — add a
 * path here the same commit you add it to package.json#exports.
 */
const UTILS_MIGRATED_FILES = new Set([
    "src/utils/index.ts",
    "src/utils/json.ts",
    "src/utils/date.ts",
    "src/utils/date-locale.ts",
    "src/utils/format.ts",
    "src/utils/string.ts",
    "src/utils/array.ts",
    "src/utils/object.ts",
    "src/utils/math.ts",
    "src/utils/hash.ts",
    "src/utils/tokens.ts",
    "src/utils/Stopwatch.ts",
]);

/** A migrated file's colocated test (e.g. src/utils/json.ts -> src/utils/json.test.ts). */
function isMigratedTestFile(file: string): boolean {
    const m = file.match(/^(.*)\.test\.tsx?$/);
    return m !== null && UTILS_MIGRATED_FILES.has(`${m[1]}.ts`);
}

/** Tool dirs/files under src/ that are NOT shared packages (for tool->tool detection). */
const TOOL_IMPORT_RE = /@app\/([a-zA-Z0-9._-]+)(?:\/|"|')/;

/** A src/ subtree that is shared infra, not a tool (so @app/utils/* is never a "tool" import). */
const SHARED_SRC_PREFIXES = ["utils", "ask"];

interface ImportHit {
    file: string;
    line: number;
    spec: string;
}

/** rg every `from "<spec>"` across a scope, excluding node_modules. */
async function collectImports(scope: string): Promise<ImportHit[]> {
    // NOTE: glob patterns are interpolated as variables so Bun's `$` quotes
    // them — passing bare `-g *.ts` lets the embedded shell glob-expand `*.ts`
    // (to nothing) before rg ever sees it, silently dropping every match.
    const excludeNodeModules = "!node_modules";
    const globTs = "*.ts";
    const globTsx = "*.tsx";
    const pattern = "(?:from\\s+[\"']([^\"']+)[\"']|^\\s*import\\s+[\"']([^\"']+)[\"'])";
    const raw = await $`rg -n --no-heading -g ${excludeNodeModules} -g ${globTs} -g ${globTsx} ${pattern} ${scope}`
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

/** A `@app/<seg>` import — returns the first segment (tool name or shared prefix). */
function appSegmentOf(spec: string): string | null {
    const m = spec.match(TOOL_IMPORT_RE);
    return m ? m[1] : null;
}

const hardErrors: string[] = [];
const warnings: string[] = [];

// ---- rule 1 (FAIL): @genesiscz/utils purity, migrated files only ----
const srcHits = await collectImports("src");
for (const hit of srcHits) {
    const isMigrated = UTILS_MIGRATED_FILES.has(hit.file) || isMigratedTestFile(hit.file);
    if (!isMigrated) {
        continue;
    }

    if (hit.spec.startsWith("@app/") && hit.spec !== "@app/utils/test/skip") {
        hardErrors.push(`${hit.file}:${hit.line}  @genesiscz/utils must not import @app/* (impurity): ${hit.spec}`);
    }
}

// ---- rules 2, 3 (WARN) ----
for (const hit of srcHits) {
    const appTarget = appSegmentOf(hit.spec);
    if (appTarget === null) {
        continue;
    }

    const fromUtils = hit.file.startsWith("src/utils/");

    // Rule 2 (WARN): src/utils/* (shared infra) importing a tool — the §0.3 backlog.
    if (fromUtils && !SHARED_SRC_PREFIXES.includes(appTarget)) {
        warnings.push(
            `${hit.file}:${hit.line}  shared src/utils -> tool @app/${appTarget}/* (§0.3 backlog): ${hit.spec}`
        );
        continue;
    }

    // Rule 3 (WARN): tool -> another tool's internals.
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
    console.error(`✖ ${hardErrors.length} HARD boundary violations (@genesiscz/utils impurity):`);
    for (const e of hardErrors) {
        console.error(`  ${e}`);
    }

    process.exit(1);
}

console.log(`✓ package boundaries clean (@genesiscz/utils pure); ${warnings.length} known-backlog warnings`);
