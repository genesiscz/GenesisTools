#!/usr/bin/env bun
/**
 * Proposes roster candidates from two sources (`--source diff|shadowed|all`, default all):
 *
 * - `diff`: the call, import, constructor and argv shapes that a git range removed from several files and did not add
 *   back elsewhere. Such a shape is usually a pattern that a refactor moved into one module.
 * - `shadowed`: a helper that a shared module exports and that tools still redefine privately (`tools ts refactors
 *   --include shadowed`). A roster on its private declarations stops the next copy.
 *
 *   bun scripts/ci/rosters/propose.ts                                   # origin/master...HEAD
 *   bun scripts/ci/rosters/propose.ts --range origin/master...feat/x --min-files 3 --limit 30
 *   bun scripts/ci/rosters/propose.ts --json
 *   bun scripts/ci/rosters/propose.ts --scaffold 'call:runCmux' --name cmux-run-outside-reader --candidate C13
 *
 * For each shape it prints: how many files the range removed it from, how many lines it added back and where (the
 * module it probably moved into, the `allowedIn` guess), and how many matches are still in the tree (the roster's
 * starting size). `--scaffold` writes a NEW `<name>.definition.ts` to fill in and list in `index.ts` (it refuses an
 * existing file and writes nothing else); then `generate.ts` seeds its roster. The ranking is a heuristic: read each
 * candidate before you make it a rule.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export type ShapeKind = "call" | "import" | "new" | "argv" | "declare";

export interface Shape {
    kind: ShapeKind;
    /** The callee (`fetch`, `fs.unlinkSync`), module specifier, constructor or argv head (`launchctl`). */
    value: string;
}

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

/** Callees too common to mean anything as a roster. */
const NOISE = new Set([
    "if",
    "for",
    "while",
    "switch",
    "return",
    "function",
    "catch",
    "typeof",
    "expect",
    "describe",
    "test",
    "it",
    "push",
    "map",
    "filter",
    "join",
    "split",
    "slice",
    "includes",
    "has",
    "get",
    "set",
    "add",
    "String",
    "Number",
    "Boolean",
    "Array.isArray",
    "Object.keys",
    "Object.entries",
    "Object.values",
    "console.log",
    "console.error",
    "JSON.stringify",
    "JSON.parse",
    "SafeJSON.parse",
    "SafeJSON.stringify",
    "Math.max",
    "Math.min",
    "Math.round",
    "Date.now",
    "Promise.all",
    "log.debug",
    "log.info",
    "log.warn",
    "log.error",
    "out.log.info",
    "out.log.warn",
    "out.log.error",
    "trim",
    "replace",
    "toString",
    "then",
    "resolve",
    "require",
]);

/** A call, not a constructor: `new X(` is the `new` shape. */
const CALL = /(?<![\w$.])(?<!new\s)((?:[A-Za-z_$][\w$]*\.){0,2}[A-Za-z_$][\w$]*)\s*\(/g;
const IMPORT = /\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const NEW = /\bnew\s+([A-Z][\w$]*)\s*\(/g;
const ARGV = /\[\s*["']([a-z][a-z0-9-]{2,})["']\s*,/g;

/** The shapes one source line holds. Pure. */
export function shapesOf(line: string): Shape[] {
    const shapes: Shape[] = [];
    const code = line.replace(/\/\/.*$/, "");

    for (const match of code.matchAll(CALL)) {
        const value = match[1];
        const last = value.split(".").at(-1) ?? value;

        if (!NOISE.has(value) && !NOISE.has(last) && !/^[A-Z][A-Z0-9_]*$/.test(value) && last.length > 2) {
            shapes.push({ kind: "call", value });
        }
    }

    for (const match of code.matchAll(IMPORT)) {
        const value = match[1] ?? match[2];

        if (value && !value.startsWith(".")) {
            shapes.push({ kind: "import", value });
        }
    }

    for (const match of code.matchAll(NEW)) {
        if (!["Error", "Map", "Set", "Date", "URL", "RegExp", "Promise", "Array"].includes(match[1])) {
            shapes.push({ kind: "new", value: match[1] });
        }
    }

    for (const match of code.matchAll(ARGV)) {
        shapes.push({ kind: "argv", value: match[1] });
    }

    return shapes;
}

export function shapeKey(shape: Shape): string {
    return `${shape.kind}:${shape.value}`;
}

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
        if (line.startsWith("+++ ")) {
            file = line.slice(4).replace(/^b\//, "");
            continue;
        }

        if (line.startsWith("--- ")) {
            const old = line.slice(4).replace(/^a\//, "");
            file = old === "/dev/null" ? file : old;
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

/** The text a fixed-string grep looks for, for one shape. */
export function grepNeedle(shape: Shape): string {
    switch (shape.kind) {
        case "call":
            return `${shape.value}(`;
        case "import":
            return `"${shape.value}"`;
        case "new":
            return `new ${shape.value}(`;
        case "argv":
            return `"${shape.value}"`;
        case "declare":
            return `function ${shape.value}(`;
    }
}

interface ShadowedSite {
    file: string;
    name: string;
    canonical?: boolean;
}

interface ShadowedReport {
    recommendations?: { title: string; sites?: ShadowedSite[] }[];
}

/** The private copies of an exported helper, as roster candidates (from `tools ts refactors --include shadowed`). Pure. */
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

    return candidates;
}

function readShadowed(): ShadowedReport {
    const run = Bun.spawnSync(["tools", "ts", "refactors", "src", "--include", "shadowed", "--format", "json"]);

    if (run.exitCode !== 0) {
        throw new Error(`tools ts refactors failed: ${run.stderr.toString().slice(-400)}`);
    }

    const value: unknown = SafeJSON.parse(run.stdout.toString(), { strict: true });
    return typeof value === "object" && value !== null ? (value as ShadowedReport) : {};
}

function countInTree(shape: Shape): number {
    const grep = Bun.spawnSync(["git", "grep", "-c", "-F", "-e", grepNeedle(shape), "--", "src/*.ts", "src/*.tsx"]);

    if (grep.exitCode === 1) {
        return 0;
    }

    if (grep.exitCode !== 0) {
        throw new Error(`git grep failed: ${grep.stderr.toString()}`);
    }

    return grep.stdout
        .toString()
        .split("\n")
        .filter((line) => line && !/\.test\.tsx?:/.test(line))
        .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(":") + 1)), 0);
}

/** The matcher source of a scaffolded definition, for one shape. Pure. */
export function matcherSource(shape: Shape): string {
    const escaped = shape.value.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&");

    switch (shape.kind) {
        case "call":
            return `callTo([${SafeJSON.stringify(shape.value.split(".").at(-1))}])`;
        case "import":
            return `{ rule: { kind: "import_statement", has: { kind: "string", regex: "${escaped}" } } }`;
        case "new":
            return `{ rule: { kind: "new_expression", has: { field: "constructor", regex: "^${escaped}$" } } }`;
        case "argv":
            return `{ rule: { kind: "array", has: { kind: "string", regex: "^[\\"'\`]${escaped}[\\"'\`]$" } } }`;
        case "declare":
            return `{ rule: { kind: "function_declaration", has: { field: "name", regex: "^${escaped}$" } } }`;
    }
}

export function scaffold(input: { shape: Shape; name: string; candidate: string; allowedIn: string | null }): string {
    const imports = input.shape.kind === "call" ? "callTo, defineRoster" : "defineRoster";
    const allowed = input.allowedIn
        ? `    allowedIn: /^${input.allowedIn.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$/,\n`
        : "    // allowedIn: the module that owns the pattern,\n";

    return `import { ${imports} } from "./define";

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

function parseShape(text: string): Shape {
    const [kind, ...rest] = text.split(":");

    if (!["call", "import", "new", "argv", "declare"].includes(kind) || rest.length === 0) {
        throw new Error(`--scaffold takes <call|import|new|argv|declare>:<value>, got ${text}`);
    }

    return { kind: kind as ShapeKind, value: rest.join(":") };
}

if (import.meta.main) {
    const range = argValue("--range") ?? "origin/master...HEAD";
    const minFiles = Number(argValue("--min-files") ?? 3);
    const limit = Number(argValue("--limit") ?? 25);
    const diff = Bun.spawnSync(["git", "diff", "-U0", "--no-color", "--no-ext-diff", range, "--", "*.ts", "*.tsx"]);

    if (diff.exitCode !== 0) {
        console.error(`rosters propose: git diff ${range} failed: ${diff.stderr.toString()}`);
        process.exit(2);
    }

    const stats = collectShapes(
        diff.stdout.toString(),
        (file) => !file.startsWith("src/") || /\.test\.tsx?$/.test(file)
    );
    const source = argValue("--source") ?? "all";
    const scaffoldArg = argValue("--scaffold");

    if (scaffoldArg) {
        const shape = parseShape(scaffoldArg);
        const name = argValue("--name");

        if (!name || !/^[a-z0-9-]+$/.test(name)) {
            console.error("rosters propose: --scaffold needs --name <kebab-case>");
            process.exit(2);
        }

        const path = join(import.meta.dir, `${name}.definition.ts`);

        if (existsSync(path)) {
            console.error(`rosters propose: ${path} exists`);
            process.exit(2);
        }

        const added = stats.get(shapeKey(shape));
        const owner =
            shape.kind === "declare"
                ? (shadowedCandidates(readShadowed()).find((c) => c.value === shape.value)?.addedIn[0] ?? null)
                : null;
        const allowedIn =
            owner ?? (added ? ([...added.addedFiles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) : null);
        // "wx": create only, so a race with another writer can never overwrite a definition.
        writeFileSync(path, scaffold({ shape, name, candidate: argValue("--candidate") ?? "C00", allowedIn }), {
            flag: "wx",
        });
        console.log(`wrote ${path}: fill the TODOs, add it to index.ts, then run bun scripts/ci/rosters/generate.ts`);
        process.exit(0);
    }

    const candidates = [
        ...(source === "shadowed" ? [] : rankCandidates(stats, { minFiles, remaining: countInTree }).slice(0, limit)),
        ...(source === "diff" ? [] : shadowedCandidates(readShadowed()).slice(0, limit)),
    ];

    if (process.argv.includes("--json")) {
        console.log(SafeJSON.stringify(candidates, null, 2));
        process.exit(0);
    }

    console.log(`Roster candidates in ${range} (removed from >= ${minFiles} files, not added back as widely):\n`);

    for (const c of candidates.filter((candidate) => candidate.source === "diff")) {
        console.log(
            `${c.score.toString().padStart(6)}  ${c.key}  removed ${c.removedLines} lines in ${c.removedFiles} files, ` +
                `added ${c.addedLines}${c.addedIn.length ? ` (${c.addedIn.join(", ")})` : ""}, ${c.remaining} left in src`
        );
    }

    const shadowed = candidates.filter((candidate) => candidate.source === "shadowed");

    if (shadowed.length > 0) {
        console.log("\nExported helpers that tools still redefine privately:\n");

        for (const c of shadowed) {
            console.log(`${c.remaining.toString().padStart(6)}  ${c.key}  owner ${c.addedIn[0]}`);
        }
    }

    console.log(
        `\nScaffold one: bun scripts/ci/rosters/propose.ts --range ${range} --scaffold '<key>' --name <slug> --candidate C<n>`
    );
}
