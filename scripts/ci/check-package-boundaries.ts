#!/usr/bin/env bun
/**
 * Package-boundary guard for the @gt/* monorepo (MONOREPO-SPEC.md §1.4).
 *
 * This repo enforces conventions with bespoke Bun CI scripts
 * (logging-guard.sh, check-ui-palette.ts); boundary enforcement follows the
 * same idiom. It is the mechanism that makes "enforced boundaries" real — the
 * layered dependency direction (SPEC §2.1) cannot erode silently.
 *
 * RULES (foundation = warn-mode for the backlog; rules flip to FAIL per phase):
 *  1. FAIL — @gt/core purity: a file in packages/core/** may import only
 *     @gt/core (sibling subpaths / the package itself) or third-party
 *     node_modules. ANY @app/* or @gt/<other> import is a hard error. This is
 *     fail-from-day-one because @gt/core is the genuinely import-closed leaf.
 *  2. FAIL — layer back-edges: a packages/<A> file may import @gt/<B> only when
 *     B is at the same-or-lower layer than A (toward L0). A back-edge (toward a
 *     higher layer) is a hard error. Only @gt/core exists today, so this rule
 *     is vacuously green now and tightens as packages land.
 *  3. FAIL — package -> tool: a packages/** file must never import @app/<tool>/*
 *     (a package may not depend on a tool). EXCEPT the §0.3 backlog under
 *     src/utils/* — those still live in src/, not packages/, so they are caught
 *     by rule 4 in WARN mode until their extraction phase moves + fixes them.
 *  4. WARN — known reverse-dep backlog (SPEC §0.3): src/utils/* importing
 *     @app/<tool>/* (log-viewer -> task/debugging-master, ui/components/youtube
 *     -> youtube, cmux <-> cmux, github -> github, notifications -> telegram-bot,
 *     ai/tasks -> tools). These are real violations; each flips to FAIL in the
 *     phase that breaks its cycle. Warns do NOT fail the build.
 *  5. WARN — tool -> tool: src/<tool> importing another tool's internals
 *     (@app/<otherTool>/*). Flips to FAIL in the cutover phase.
 *
 * Run: `bun scripts/ci/check-package-boundaries.ts`
 */
import { $ } from "bun";

type Layer = number;

/**
 * Layer order: lower number = lower layer (toward the pure leaf). A package may
 * depend only on packages at the SAME or a LOWER layer. As packages are
 * extracted in follow-up phases, add them here with their layer per SPEC §2.1.
 */
const PACKAGE_LAYER: Record<string, Layer> = {
    core: 0,
    // L1: "cli-core": 1, logger: 1, prompts: 1, storage: 1, fs: 1, process: 1,
    // L2: database: 2, net: 2, search: 2,
    // L3: ai: 3, macos: 3, github: 3, claude: 3, agents: 3, markdown: 3, audio: 3, notifications: 3,
    // L4: ui: 4, tui: 4, cmux: 4, tmux: 4,
};

/** Tool dirs/files under src/ that are NOT shared packages (for tool->tool detection). */
const TOOL_IMPORT_RE = /@app\/([a-zA-Z0-9._-]+)(?:\/|")/;

/** A src/ subtree that is shared infra, not a tool (so @app/utils/* is never a "tool" import). */
const SHARED_SRC_PREFIXES = ["utils", "logger", "ask"];

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
    const pattern = "from\\s+[\"']([^\"']+)[\"']";
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
        const specMatch = rest.match(/from\s+["']([^"']+)["']/);
        if (!specMatch) {
            continue;
        }

        hits.push({ file, line: Number(lineNo), spec: specMatch[1] });
    }

    return hits;
}

/** Which package does a packages/** file belong to? `packages/core/src/x.ts` -> "core". */
function packageOf(file: string): string | null {
    const m = file.match(/^packages\/([^/]+)\//);
    return m ? m[1] : null;
}

/** A `@gt/<name>` import resolves to package `<name>`. */
function gtPackageOf(spec: string): string | null {
    const m = spec.match(/^@gt\/([^/]+)/);
    return m ? m[1] : null;
}

/** A `@app/<seg>` import — returns the first segment (tool name or shared prefix). */
function appSegmentOf(spec: string): string | null {
    const m = spec.match(TOOL_IMPORT_RE);
    return m ? m[1] : null;
}

const hardErrors: string[] = [];
const warnings: string[] = [];

// ---- packages/** rules (1, 2, 3) ----
const pkgHits = await collectImports("packages");
for (const hit of pkgHits) {
    const pkg = packageOf(hit.file);
    if (pkg === null) {
        continue;
    }

    const gtTarget = gtPackageOf(hit.spec);
    const appTarget = appSegmentOf(hit.spec);

    const isTest = /\.test\.tsx?$/.test(hit.file);

    // Rule 1: @gt/core purity — may import only @gt/core or node_modules.
    if (pkg === "core") {
        // Colocated *.test.ts files are dev-only and not part of the package's
        // `exports` closure, so they may use shared test infra (e.g.
        // @app/utils/test/skip — itself a clean leaf). The purity contract is
        // about what CONSUMERS import, i.e. the source modules.
        if (hit.spec.startsWith("@app/") && !isTest) {
            hardErrors.push(`${hit.file}:${hit.line}  @gt/core must not import @app/* (impurity): ${hit.spec}`);
            continue;
        }

        if (gtTarget !== null && gtTarget !== "core") {
            hardErrors.push(
                `${hit.file}:${hit.line}  @gt/core must not import @gt/${gtTarget} (leaf must stay closed): ${hit.spec}`
            );
            continue;
        }

        continue;
    }

    // Rule 3: package -> tool is forbidden (a package may never depend on a tool).
    if (appTarget !== null && !SHARED_SRC_PREFIXES.includes(appTarget)) {
        hardErrors.push(
            `${hit.file}:${hit.line}  package @gt/${pkg} must not import tool @app/${appTarget}/*: ${hit.spec}`
        );
        continue;
    }

    // Rule 2: layer back-edges.
    if (gtTarget !== null && gtTarget !== pkg) {
        const from = PACKAGE_LAYER[pkg];
        const to = PACKAGE_LAYER[gtTarget];
        if (from !== undefined && to !== undefined && to > from) {
            hardErrors.push(
                `${hit.file}:${hit.line}  layer back-edge: @gt/${pkg} (L${from}) may not import @gt/${gtTarget} (L${to}): ${hit.spec}`
            );
        }
    }
}

// ---- src/** rules (4 warn, 5 warn) ----
const srcHits = await collectImports("src");
for (const hit of srcHits) {
    const appTarget = appSegmentOf(hit.spec);
    if (appTarget === null) {
        continue;
    }

    const fromUtils = hit.file.startsWith("src/utils/");
    const fromLogger = hit.file === "src/logger.ts" || hit.file.startsWith("src/logger/");

    // Rule 4 (WARN): src/utils/* (shared infra) importing a tool — the §0.3 backlog.
    if ((fromUtils || fromLogger) && !SHARED_SRC_PREFIXES.includes(appTarget)) {
        warnings.push(
            `${hit.file}:${hit.line}  shared src/utils -> tool @app/${appTarget}/* (§0.3 backlog): ${hit.spec}`
        );
        continue;
    }

    // Rule 5 (WARN): tool -> another tool's internals.
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
    console.error(
        `✖ ${hardErrors.length} HARD boundary violations (layer back-edge / package-impurity / package->tool):`
    );
    for (const e of hardErrors) {
        console.error(`  ${e}`);
    }

    process.exit(1);
}

console.log(
    `✓ package boundaries clean (@gt/core pure, no back-edges, no package->tool); ${warnings.length} known-backlog warnings`
);
