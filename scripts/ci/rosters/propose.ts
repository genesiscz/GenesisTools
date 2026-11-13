#!/usr/bin/env bun
/**
 * Proposes roster candidates from four sources (`--source diff|pairs|census|shadowed|all`, default all):
 *
 * - `pairs` (needs `--range`): substitutions. In each hunk, a shape only on the removed side and a shape only on the
 *   added side form an (X -> Y) pair; a pair seen in many files means "X was replaced by Y": keep X out, and the
 *   module that declares Y owns it. See `propose-pairs.ts`.
 * - `census` (today's tree, no range): argv heads of spawned CLIs, third-party imports, constructors of imported
 *   classes and state file names (`cmux-refs.jsonl`) that one module already holds almost alone. A fully owned shape
 *   (nothing outside its module) gets a roster with an empty baseline. See `propose-census.ts`.
 * - `diff` (needs `--range`): the call, import, constructor and argv shapes that the range removed from several files
 *   and did not add back elsewhere. Noisier than `pairs`: a shape that vanished is not always a shape that moved.
 * - `shadowed`: a helper that a shared module exports and that tools still redefine privately (`tools ts refactors
 *   --include shadowed`). A roster on its private declarations stops the next copy.
 *
 *   bun scripts/ci/rosters/propose.ts                                   # census + shadowed
 *   bun scripts/ci/rosters/propose.ts --range origin/master...feat/x --min-files 3 --limit 30
 *   bun scripts/ci/rosters/propose.ts --source census --json
 *   bun scripts/ci/rosters/propose.ts --scaffold 'literal:cmux-refs.jsonl' --name cmux-refs-outside-store --candidate C13
 *
 * `--scaffold` writes a NEW `<name>.definition.ts` to fill in and list in `index.ts` (it refuses an existing file and
 * writes nothing else); with `--range` its `allowedIn` is where the range added the shape back, without it the module
 * the census names as owner. Then `generate.ts` seeds its roster. The ranking is a heuristic: read each candidate
 * before you make it a rule.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFiles } from "@app/ts/lib/load";
import { resolveAnalysers, runRefactors } from "@app/ts/lib/refactors";
import { SafeJSON } from "@genesiscz/utils/json";
import { census } from "./propose-census";
import { collectPairs, ownerOfShape, rankPairs } from "./propose-pairs";
import {
    allowedInSource,
    countInTree,
    isTestPath,
    parseShape,
    type Shape,
    type ShapeKind,
    shapeKey,
    shapesOf,
    treeUsage,
} from "./propose-shapes";

export type { Shape, ShapeKind } from "./propose-shapes";

export interface ShapeStats {
    shape: Shape;
    removedFiles: Set<string>;
    removedLines: number;
    addedFiles: Map<string, number>;
    addedLines: number;
}

export interface Candidate {
    key: string;
    kind: ShapeKind;
    value: string;
    removedFiles: number;
    removedLines: number;
    addedLines: number;
    /** Where the range added the shape back, or the module that exports it: the likely owning module. */
    addedIn: string[];
    source: "diff" | "shadowed";
    /** Matches still in the tree today (a fixed-string grep of the shape's text). */
    remaining: number;
    score: number;
}
export { grepNeedle, shapeKey, shapesOf } from "./propose-shapes";

/** Reads a unified diff with zero context and counts every shape on its removed and added lines. Pure. */
export function collectShapes(diff: string, skip: (file: string) => boolean): Map<string, ShapeStats> {
    const stats = new Map<string, ShapeStats>();
    let file = "";

    const entry = (shape: Shape): ShapeStats => {
        const key = shapeKey(shape);
        let found = stats.get(key);

        if (!found) {
            found = { shape, removedFiles: new Set(), removedLines: 0, addedFiles: new Map(), addedLines: 0 };
            stats.set(key, found);
        }

        return found;
    };

    for (const line of diff.split("\n")) {
        if (line.startsWith("--- ")) {
            const old = line.slice(4).replace(/^a\//, "");
            file = old === "/dev/null" ? "" : old;
            continue;
        }

        if (line.startsWith("+++ ")) {
            const next = line.slice(4).replace(/^b\//, "");
            // A deleted file's new side is /dev/null: its removed lines still belong to the old path.
            file = next === "/dev/null" ? file : next;
            continue;
        }

        if (!file || skip(file)) {
            continue;
        }

        if (line.startsWith("-") && !line.startsWith("---")) {
            for (const shape of new Map(shapesOf(line.slice(1)).map((s) => [shapeKey(s), s])).values()) {
                const found = entry(shape);
                found.removedFiles.add(file);
                found.removedLines += 1;
            }
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
            for (const shape of new Map(shapesOf(line.slice(1)).map((s) => [shapeKey(s), s])).values()) {
                const found = entry(shape);
                found.addedFiles.set(file, (found.addedFiles.get(file) ?? 0) + 1);
                found.addedLines += 1;
            }
        }
    }

    return stats;
}

/**
 * The shapes worth a roster: removed from at least `minFiles` files, and added back in fewer files than it left
 * (it moved into a module, it did not move around). Higher score = more files cleaned, fewer left behind. Pure.
 */
export function rankCandidates(
    stats: Map<string, ShapeStats>,
    { minFiles, remaining }: { minFiles: number; remaining: (shape: Shape) => number }
): Candidate[] {
    const candidates: Candidate[] = [];

    for (const [key, stat] of stats) {
        const removedFiles = stat.removedFiles.size;

        if (removedFiles < minFiles || stat.addedFiles.size >= removedFiles || stat.addedLines >= stat.removedLines) {
            continue;
        }

        const left = remaining(stat.shape);
        const addedIn = [...stat.addedFiles.entries()].sort((a, b) => b[1] - a[1]).map(([file]) => file);
        const score = removedFiles * 2 + (stat.removedLines - stat.addedLines) - left * 0.5 - addedIn.length;

        candidates.push({
            key,
            kind: stat.shape.kind,
            value: stat.shape.value,
            removedFiles,
            removedLines: stat.removedLines,
            addedLines: stat.addedLines,
            addedIn: addedIn.slice(0, 3),
            source: "diff",
            remaining: left,
            score: Math.round(score * 10) / 10,
        });
    }

    return candidates.sort((a, b) => b.score - a.score);
}

interface ShadowedSite {
    file: string;
    name: string;
    canonical?: boolean;
}

interface ShadowedReport {
    recommendations?: { title: string; sites?: ShadowedSite[] }[];
}

/**
 * The private copies of an exported helper, as roster candidates (from the `shadowed` refactor analyser), most copies
 * first: the analyser ranks by saved lines, and the caller cuts the list at `--limit`. Pure.
 */
export function shadowedCandidates(report: ShadowedReport): Candidate[] {
    const candidates: Candidate[] = [];

    for (const recommendation of report.recommendations ?? []) {
        const sites = recommendation.sites ?? [];
        const owner = sites.find((site) => site.canonical);
        const copies = sites.filter((site) => !site.canonical && !/\.test\.tsx?$/.test(site.file));

        if (!owner || copies.length === 0) {
            continue;
        }

        candidates.push({
            key: `declare:${owner.name}`,
            kind: "declare",
            value: owner.name,
            removedFiles: 0,
            removedLines: 0,
            addedLines: 0,
            addedIn: [owner.file],
            source: "shadowed",
            remaining: copies.length,
            score: copies.length,
        });
    }

    return candidates.sort((a, b) => b.score - a.score);
}

/**
 * The `shadowed` analyser of `tools ts refactors`, run in this process on this checkout's `src/` (a spawned `tools`
 * would be the main checkout's from PATH). Every recommendation, with the CLI's defaults otherwise.
 */
async function readShadowed(): Promise<ShadowedReport> {
    const loaded = await loadFiles(["src"], { tests: false, hash: true, imports: true });

    if (loaded.empty.length > 0) {
        fail(`no TypeScript source in ${loaded.empty.join(", ")}`);
    }

    return runRefactors(resolveAnalysers("shadowed"), {
        entries: loaded.entries,
        modules: loaded.modules,
        options: { minLines: 3, similarity: 0.8, limit: Number.POSITIVE_INFINITY },
    });
}

/** The matcher source of a scaffolded definition, for one shape. Pure. */
export function matcherSource(shape: Shape): string {
    const escaped = shape.value.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&");
    const literalText = shape.value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const exact = `/^${literalText}$/`;

    switch (shape.kind) {
        case "call":
            return `callTo([${SafeJSON.stringify(shape.value.split(".").at(-1))}])`;
        case "import":
            // The package and its subpaths (`zod/v4`): the census counts a package, not one specifier.
            return `importFrom(/^${literalText}(?:\\/|$)/)`;
        case "new":
            return `{ rule: { kind: "new_expression", has: { field: "constructor", regex: "^${escaped}$" } } }`;
        case "argv":
            return `{ rule: { kind: "array", has: { kind: "string", regex: "^[\\"'\`]${escaped}[\\"'\`]$" } } }`;
        case "declare":
            return `declaration(${exact})`;
        case "literal":
            return `literal(${exact})`;
    }
}

const SCAFFOLD_IMPORTS: Record<ShapeKind, string> = {
    call: "callTo, defineRoster",
    import: "defineRoster, importFrom",
    new: "defineRoster",
    argv: "defineRoster",
    declare: "declaration, defineRoster",
    literal: "defineRoster, literal",
};

/**
 * A new definition. `allowedIn` is a module: a folder ending with `/` becomes a prefix regex, a file an exact one.
 * Pure.
 */
export function scaffold(input: { shape: Shape; name: string; candidate: string; allowedIn: string | null }): string {
    const allowed = input.allowedIn
        ? `    allowedIn: /${allowedInSource(input.allowedIn)}/,\n`
        : "    // allowedIn: the module that owns the pattern,\n";

    return `import { ${SCAFFOLD_IMPORTS[input.shape.kind]} } from "./define";

/** ${input.candidate}: TODO say what went wrong when this pattern lived in many files. */
export default defineRoster({
    name: "roster-${input.name}",
    candidate: "${input.candidate}",
    message: "TODO: what to call instead, and what the bypass skips.",
    matcher: ${matcherSource(input.shape)},
    onlyIn: /^src\\//,
${allowed}});
`;
}

function argValue(flag: string): string | undefined {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const SOURCES = ["diff", "pairs", "census", "shadowed", "all"] as const;
type Source = (typeof SOURCES)[number];

function fail(message: string): never {
    console.error(`rosters propose: ${message}`);
    process.exit(2);
}

function readDiff(range: string): string {
    const diff = Bun.spawnSync(["git", "diff", "-U0", "--no-color", "--no-ext-diff", range, "--", "*.ts", "*.tsx"]);

    if (diff.exitCode !== 0) {
        fail(`git diff ${range} failed: ${diff.stderr.toString()}`);
    }

    return diff.stdout.toString();
}

/** Tracked non-test TypeScript under src/, each file read once. */
function readSourceTree(): Map<string, string> {
    const list = Bun.spawnSync(["git", "ls-files", "-z", "--", "src/*.ts", "src/*.tsx"]);

    if (list.exitCode !== 0) {
        fail(`git ls-files failed: ${list.stderr.toString()}`);
    }

    const files = new Map<string, string>();

    for (const file of list.stdout.toString().split("\0")) {
        if (!file || isTestPath(file) || file.endsWith(".d.ts") || !existsSync(file)) {
            continue;
        }

        files.set(file, readFileSync(file, "utf8"));
    }

    return files;
}

/** The root package.json dependencies: the third-party packages the census counts. */
function rootPackages(): Set<string> {
    const parsed: unknown = SafeJSON.parse(readFileSync("package.json", "utf8"), { strict: true });
    const names = new Set<string>();

    if (typeof parsed !== "object" || parsed === null) {
        return names;
    }

    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const deps: unknown = Reflect.get(parsed, field);

        if (typeof deps === "object" && deps !== null) {
            for (const name of Object.keys(deps)) {
                names.add(name);
            }
        }
    }

    return names;
}

const commandCache = new Map<string, boolean>();

/** Whether a name is an executable on PATH (`launchctl`, `osascript`), cached. */
function isCommand(name: string): boolean {
    let found = commandCache.get(name);

    if (found === undefined) {
        found = Bun.which(name) !== null;
        commandCache.set(name, found);
    }

    return found;
}

/** Skips files outside src/ and tests: the diff and pairs sources only count product code. */
const skipFile = (file: string): boolean => !file.startsWith("src/") || isTestPath(file);

async function runScaffold(scaffoldArg: string, range: string | undefined): Promise<never> {
    const shape = parseShape(scaffoldArg);
    const name = argValue("--name");

    if (!name || !/^[a-z0-9-]+$/.test(name)) {
        fail("--scaffold needs --name <kebab-case>");
    }

    const path = join(import.meta.dir, `${name}.definition.ts`);

    if (existsSync(path)) {
        fail(`${path} exists`);
    }

    let allowedIn: string | null = null;

    if (shape.kind === "declare") {
        allowedIn = shadowedCandidates(await readShadowed()).find((c) => c.value === shape.value)?.addedIn[0] ?? null;
    } else if (range) {
        const added = collectShapes(readDiff(range), skipFile).get(shapeKey(shape));
        allowedIn = added ? ([...added.addedFiles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) : null;
    } else {
        // No range: the module that owns the shape in today's tree, when the census sees it at all.
        const owned = census(readSourceTree(), {
            packages: rootPackages(),
            minShare: 0,
            maxOutliers: Number.POSITIVE_INFINITY,
        }).find((c) => c.key === shapeKey(shape));
        allowedIn = owned?.owner ?? null;
    }

    // "wx": create only, so a race with another writer can never overwrite a definition.
    writeFileSync(path, scaffold({ shape, name, candidate: argValue("--candidate") ?? "C00", allowedIn }), {
        flag: "wx",
    });
    console.log(`wrote ${path}: fill the TODOs, add it to index.ts, then run bun scripts/ci/rosters/generate.ts`);
    process.exit(0);
}

if (import.meta.main) {
    const range = argValue("--range");
    const minFiles = Number(argValue("--min-files") ?? 3);
    const limit = Number(argValue("--limit") ?? 25);
    const sourceArg = argValue("--source") ?? "all";
    const source = SOURCES.find((s) => s === sourceArg) ?? fail(`--source takes ${SOURCES.join("|")}`);
    const scaffoldArg = argValue("--scaffold");

    if (scaffoldArg) {
        await runScaffold(scaffoldArg, range);
    }

    const wants = (s: Source) => source === s || source === "all";

    if (!range && (source === "diff" || source === "pairs")) {
        fail(`--source ${source} needs --range <base>...<head>`);
    }

    const diff = range && (wants("diff") || wants("pairs")) ? readDiff(range) : "";
    const timings: string[] = [];
    const timed = async <T>(label: string, work: () => T | Promise<T>): Promise<T> => {
        const started = performance.now();
        const result = await work();
        timings.push(`${label} ${((performance.now() - started) / 1000).toFixed(1)} s`);
        return result;
    };

    const diffRows =
        range && wants("diff")
            ? await timed("diff", () =>
                  rankCandidates(collectShapes(diff, skipFile), { minFiles, remaining: countInTree }).slice(0, limit)
              )
            : [];
    const pairRows =
        range && wants("pairs")
            ? await timed("pairs", () =>
                  rankPairs(collectPairs(diff, skipFile), {
                      minFiles,
                      remaining: treeUsage,
                      owner: ownerOfShape,
                      limit,
                  })
              )
            : [];
    const censusRows = wants("census")
        ? await timed("census", () =>
              census(readSourceTree(), { minFiles, packages: rootPackages(), isCommand }).slice(0, limit)
          )
        : [];
    const shadowedRows = wants("shadowed")
        ? await timed("shadowed", async () => shadowedCandidates(await readShadowed()).slice(0, limit))
        : [];

    if (process.argv.includes("--json")) {
        console.log(SafeJSON.stringify([...diffRows, ...pairRows, ...censusRows, ...shadowedRows], null, 2));
        process.exit(0);
    }

    if (!range && source === "all") {
        console.log("(diff and pairs skipped: they need --range <base>...<head>)\n");
    }

    if (diffRows.length > 0) {
        console.log(`Shapes ${range} removed from >= ${minFiles} files and did not add back as widely:\n`);

        for (const c of diffRows) {
            console.log(
                `${c.score.toString().padStart(6)}  ${c.key}  removed ${c.removedLines} lines in ${c.removedFiles} files, ` +
                    `added ${c.addedLines}${c.addedIn.length ? ` (${c.addedIn.join(", ")})` : ""}, ${c.remaining} left in src`
            );
        }

        console.log("");
    }

    if (pairRows.length > 0) {
        console.log(`Substitutions ${range} made in >= ${minFiles} files (X -> Y: keep X out, Y's module owns it):\n`);

        for (const p of pairRows) {
            console.log(
                `${p.files.toString().padStart(4)} files  ${shapeKey(p.from)} -> ${[p.to, ...p.alsoTo].map(shapeKey).join(" | ")}  ` +
                    `conf ${p.confidence}, ${p.remainingFiles} files still hold X, owner ${p.owner ?? "?"}  (e.g. ${p.examples.join(", ")})`
            );
        }

        console.log("");
    }

    if (censusRows.length > 0) {
        console.log("Shapes one module of today's tree owns (fully owned first):\n");

        for (const c of censusRows) {
            const outliers =
                c.outliers.length === 0
                    ? "fully owned"
                    : `${c.outliers.length} outside: ${c.outliers.slice(0, 5).join(", ")}${c.outliers.length > 5 ? ", …" : ""}`;
            console.log(
                `${c.key}  owner ${c.owner} (${c.ownerFiles}/${c.totalFiles} files, share ${c.share})  ${outliers}  ` +
                    `allowedIn /${c.allowedIn}/`
            );
        }

        console.log("");
    }

    if (shadowedRows.length > 0) {
        console.log("Exported helpers that tools still redefine privately:\n");

        for (const c of shadowedRows) {
            console.log(`${c.remaining.toString().padStart(6)}  ${c.key}  owner ${c.addedIn[0]}`);
        }

        console.log("");
    }

    console.log(`(${timings.join(", ")})`);
    console.log(
        `Scaffold one: bun scripts/ci/rosters/propose.ts [--range ${range ?? "<base>...<head>"}] --scaffold '<key>' --name <slug> --candidate C<n>`
    );
}
