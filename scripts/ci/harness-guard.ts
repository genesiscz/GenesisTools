#!/usr/bin/env bun
/**
 * The harness guard (plan "Plugenize the harnesses", section 2.6; repo plan
 * `.claude/plans/2026-10-30-PlugenizeHarnesses.md`, phase P0).
 *
 * It finds code that spells the set of coding agents (claude, codex, grok) outside the drivers, in four shapes:
 *
 * - `list`: an array or a type union with two or more of the names (`["claude", "codex"]`, `"claude" | "grok"`);
 * - `table`: an object literal with two or more of them as keys, or a `Record<HarnessType, …>` keyed by one of the
 *   harness types (the exhaustive tables of the 2026-10-30 ratchet migration, which move into driver parts);
 * - `branch`: a comparison or a `case` on one of the names (lint-rules `no-harness-name-branch` already fails the
 *   ones whose operand names a harness; this counts every one);
 * - Swift (`src/macos/**\/Sources`, not `Generated/`): a line with a `case` or `==` on a name, or two name literals.
 *
 * Every file that does it today is in `harness-guard-allowlist.ts` with its counts. The allowlist may only shrink:
 * a count above the allowance is NEW, a count below it (or a file that no longer offends) is STALE and must be
 * lowered in the same commit. REPORT mode (the default, P0 to P7) prints both and exits 0; `--strict` (P8) exits 1
 * on either. `--write-allowlist` rewrites the allowlist from the tree (P0 only: it also takes in whatever another
 * session has uncommitted). `--update-allowlist <file>...` sets the entries of the named files to what they hold now
 * and leaves every other entry alone, which is what a phase that fixes those files runs.
 *
 * Exit codes: 0 report or clean, 1 strict violation, 2 a broken scan (`git ls-files` failed).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { SafeJSON } from "@genesiscz/utils/json";
import { HARNESS_GUARD_ALLOWLIST, type HarnessGuardCounts } from "./harness-guard-allowlist";

export type HarnessGuardKind = "list" | "table" | "branch";

export interface HarnessGuardHit {
    file: string;
    line: number;
    kind: HarnessGuardKind;
    text: string;
}

const NAMES = new Set(["claude", "codex", "grok"]);
const NAME_LITERAL = /^(["'`])(claude|codex|grok)\1$/;
const PREFILTER = /["'`](?:claude|codex|grok)["'`]|\b(?:claude|codex|grok)\s*[:,}]|Record\s*<\s*[A-Z]/;
const COMPARE_OPS = new Set(["===", "!==", "==", "!="]);

/** Type names that stand for the harness set (the canonical alias, its derived aliases, and the independent copies). */
export const HARNESS_TYPE_NAMES: ReadonlySet<string> = new Set([
    "AccountProviderAlias",
    "HarnessId",
    "AgentKind",
    "AgentId",
    "AgentHarness",
    "CompactSource",
    "Harness",
    "HarnessName",
    "NativeCompactSource",
    "NativeSessionProvider",
    "NativeSourceId",
    "SearchProvider",
    "SessionAgentId",
    "StatuslineHost",
    "TranscriptProvider",
    "TurnProvider",
    "WorkerBackend",
    "AgentProvider",
]);

/**
 * P8 of `.claude/plans/2026-10-30-PlugenizeHarnesses.md` flips this one line: the guard then runs `--strict` by itself
 * (the CI step needs no edit), and `scripts/ci/lint-rules.ts` reports every violation as an error, so a local lint
 * fails before a push. On since 2026-10-31: every allowlisted file says why.
 */
export const HARNESS_GUARD_STRICT = true;

/** The drivers and the canonical list own the names; tests and fixtures spell them on purpose. */
const OWNERS =
    /^(?:src\/utils\/harness\/|src\/utils\/ai\/providers\/(?:plugins\/|alias-list\.ts$|harness-index\.ts$|harness-hooks\.ts$)|scripts\/ci\/harness-guard)/;
const TESTS = /\.test\.tsx?$|(?:^|\/)__tests__\/|(?:^|\/)(?:testing|fixtures?|Tests)\/|\/Generated\//;
const TS_SCOPE = /^(?:src|scripts|plugins)\/.*\.tsx?$/;
const SWIFT_SCOPE = /^src\/macos\/.*\/Sources\/.*\.swift$/;

export function inScope(file: string): boolean {
    return (TS_SCOPE.test(file) || SWIFT_SCOPE.test(file)) && !OWNERS.test(file) && !TESTS.test(file);
}

function lineOf(node: SgNode): number {
    return node.range().start.line + 1;
}

function rangeKey(node: SgNode): string {
    const { start, end } = node.range();
    return `${start.index}:${end.index}`;
}

function oneLine(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
}

function nameLiteralCount(node: SgNode): number {
    return node
        .findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } })
        .filter((literal) => NAME_LITERAL.test(literal.text())).length;
}

/** The outermost union a literal type sits in (`"a" | "b" | "c"` nests as union(union(a, b), c)). */
function topUnion(node: SgNode): SgNode | null {
    let current = node.parent();
    let top: SgNode | null = null;

    while (current?.kind() === "union_type") {
        top = current;
        current = current.parent();
    }

    return top;
}

function isComparison(literal: SgNode): boolean {
    const parent = literal.parent();

    if (parent?.kind() === "switch_case") {
        return true;
    }

    return parent?.kind() === "binary_expression" && COMPARE_OPS.has(parent.field("operator")?.text() ?? "");
}

/** The harness key of an object member: a `pair`'s key, or a shorthand `{ claude, codex }` member's own name. */
function pairKey(pair: SgNode): string | null {
    if (pair.kind() === "shorthand_property_identifier") {
        return pair.text();
    }

    const key = pair.field("key");

    if (!key) {
        return null;
    }

    return key.text().replace(/^["'`]|["'`]$/g, "");
}

export function scanTypeScript(file: string, source: string): HarnessGuardHit[] {
    if (!PREFILTER.test(source)) {
        return [];
    }

    const root = parse(file.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript, source).root();
    const hits: HarnessGuardHit[] = [];
    const seen = new Set<string>();
    const add = (node: SgNode, kind: HarnessGuardKind) => {
        const key = `${kind}:${rangeKey(node)}`;

        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        hits.push({ file, line: lineOf(node), kind, text: oneLine(node.text()) });
    };

    for (const literal of root.findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } })) {
        if (!NAME_LITERAL.test(literal.text())) {
            continue;
        }

        const parent = literal.parent();

        if (parent?.kind() === "array" && nameLiteralCount(parent) >= 2) {
            add(parent, "list");
            continue;
        }

        if (parent?.kind() === "literal_type") {
            const union = topUnion(parent);

            if (union && nameLiteralCount(union) >= 2) {
                add(union, "list");
            }

            continue;
        }

        if (isComparison(literal)) {
            add(literal.parent() ?? literal, "branch");
        }
    }

    for (const object of root.findAll({ rule: { kind: "object" } })) {
        const keys = object
            .children()
            .filter((child) => child.kind() === "pair" || child.kind() === "shorthand_property_identifier")
            .map(pairKey)
            .filter((key): key is string => key !== null && NAMES.has(key));

        if (new Set(keys).size >= 2) {
            add(object, "table");
        }
    }

    for (const generic of root.findAll({ rule: { kind: "generic_type" } })) {
        if (generic.field("name")?.text() !== "Record") {
            continue;
        }

        const first = generic
            .field("type_arguments")
            ?.children()
            .find((child) => child.isNamed());

        if (first && HARNESS_TYPE_NAMES.has(first.text())) {
            add(generic, "table");
        }
    }

    return hits.sort((a, b) => a.line - b.line);
}

const SWIFT_BRANCH =
    /\bcase\s+(?:\.)?(?:claude|codex|grok)\b|\bcase\s+"(?:claude|codex|grok)"|[=!]=\s*"(?:claude|codex|grok)"/;
const SWIFT_LITERAL = /"(?:claude|codex|grok)"/g;

export function scanSwift(file: string, source: string): HarnessGuardHit[] {
    const hits: HarnessGuardHit[] = [];

    for (const [index, raw] of source.split("\n").entries()) {
        const line = raw.trim();

        if (line.startsWith("//") || line.startsWith("*") || line.startsWith("///")) {
            continue;
        }

        if (SWIFT_BRANCH.test(line)) {
            hits.push({ file, line: index + 1, kind: "branch", text: oneLine(line) });
            continue;
        }

        if ((line.match(SWIFT_LITERAL) ?? []).length >= 2) {
            hits.push({ file, line: index + 1, kind: "list", text: oneLine(line) });
        }
    }

    return hits;
}

export function countsOf(hits: readonly HarnessGuardHit[]): Map<string, HarnessGuardCounts> {
    const counts = new Map<string, HarnessGuardCounts>();

    for (const hit of hits) {
        const entry = counts.get(hit.file) ?? {};
        entry[hit.kind] = (entry[hit.kind] ?? 0) + 1;
        counts.set(hit.file, entry);
    }

    return counts;
}

export interface HarnessGuardVerdict {
    /** Files whose count of a kind is above the allowance. */
    added: { file: string; kind: HarnessGuardKind; allowed: number; found: number }[];
    /** Allowlist entries above what the file has now: lower them. */
    stale: { file: string; kind: HarnessGuardKind; allowed: number; found: number }[];
}

const KINDS: readonly HarnessGuardKind[] = ["list", "table", "branch"];

export function compare(
    found: ReadonlyMap<string, HarnessGuardCounts>,
    allowlist: Readonly<Record<string, HarnessGuardCounts>>
): HarnessGuardVerdict {
    const verdict: HarnessGuardVerdict = { added: [], stale: [] };
    const files = new Set([...found.keys(), ...Object.keys(allowlist)]);

    for (const file of [...files].sort()) {
        for (const kind of KINDS) {
            const now = found.get(file)?.[kind] ?? 0;
            const allowed = allowlist[file]?.[kind] ?? 0;

            if (now > allowed) {
                verdict.added.push({ file, kind, allowed, found: now });
            } else if (now < allowed) {
                verdict.stale.push({ file, kind, allowed, found: now });
            }
        }
    }

    return verdict;
}

export function updateAllowlist(
    counts: ReadonlyMap<string, HarnessGuardCounts>,
    allowlist: Readonly<Record<string, HarnessGuardCounts>>,
    named: readonly string[]
): Map<string, HarnessGuardCounts> {
    const selected = new Set(named);
    const increases = compare(counts, allowlist).added.filter((entry) => selected.has(entry.file));

    if (increases.length > 0) {
        const entry = increases[0];
        throw new Error(`cannot increase ${entry.file} ${entry.kind} from ${entry.allowed} to ${entry.found}`);
    }

    const merged = new Map<string, HarnessGuardCounts>(Object.entries(allowlist));

    for (const file of named) {
        const now = counts.get(file);
        const why = merged.get(file)?.why;

        if (now) {
            merged.set(file, why ? { ...now, why } : now);
        } else {
            merged.delete(file);
        }
    }

    return merged;
}

function trackedFiles(repoRoot: string): string[] {
    const proc = Bun.spawnSync(["git", "ls-files", "-z", "--", "src", "scripts", "plugins"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
    });

    if (proc.exitCode !== 0) {
        process.stderr.write(`harness-guard: git ls-files failed (${proc.exitCode}): ${proc.stderr.toString()}\n`);
        process.exit(2);
    }

    return proc.stdout.toString().split("\0").filter(Boolean);
}

export function scanRepo(repoRoot: string): HarnessGuardHit[] {
    const hits: HarnessGuardHit[] = [];

    for (const file of trackedFiles(repoRoot)) {
        if (!inScope(file)) {
            continue;
        }

        let source: string;

        try {
            source = readFileSync(join(repoRoot, file), "utf8");
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                continue;
            }

            throw error;
        }

        hits.push(...(file.endsWith(".swift") ? scanSwift(file, source) : scanTypeScript(file, source)));
    }

    return hits;
}

function renderAllowlist(counts: ReadonlyMap<string, HarnessGuardCounts>): string {
    const entries = [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, entry]) => {
            const fields = KINDS.filter((kind) => entry[kind] !== undefined).map((kind) => `${kind}: ${entry[kind]}`);

            if (entry.why) {
                fields.push(`why: ${SafeJSON.stringify(entry.why)}`);
            }

            return `    "${file}": { ${fields.join(", ")} },`;
        });

    return [
        "/**",
        " * The files that spell the harness set outside the drivers, with how many lists, tables and branches each may",
        " * keep (`scripts/ci/harness-guard.ts`). Written by `bun scripts/ci/harness-guard.ts --write-allowlist`. It may",
        " * only shrink: a phase of `.claude/plans/2026-10-30-PlugenizeHarnesses.md` that moves a site into its driver",
        " * lowers the count here in the same commit. The inventory with the part letter of each site is the plan note",
        " * `GenesisTools/2026-10-08-PlugenizeTheHarnesses.plan.md` (section of 2026-10-30).",
        " *",
        " * An entry whose sites are deliberately not a harness fact (an upstream-route axis, a standalone plugin copy that",
        " * cannot import the package) says why in `why`, one line; the writer keeps it. `--strict` fails on an entry",
        " * without one, so the list ends as the justified entries only (plan P8).",
        " */",
        "export interface HarnessGuardCounts {",
        "    list?: number;",
        "    table?: number;",
        "    branch?: number;",
        "    why?: string;",
        "}",
        "",
        "export const HARNESS_GUARD_ALLOWLIST: Readonly<Record<string, HarnessGuardCounts>> = {",
        ...entries,
        "};",
        "",
    ].join("\n");
}

/**
 * What `--strict` refuses, one line each: a file above its allowance (NEW), an allowance above the file (STALE), and
 * an allowlisted file without a `why` (UNJUSTIFIED). For lint-rules, which runs it only while `HARNESS_GUARD_STRICT`.
 */
export function strictViolations(repoRoot: string): string[] {
    const counts = countsOf(scanRepo(repoRoot));
    const verdict = compare(counts, HARNESS_GUARD_ALLOWLIST);

    return [
        ...verdict.added.map(
            (entry) => `${entry.file}: ${entry.found} ${entry.kind} over its allowance of ${entry.allowed}`
        ),
        ...verdict.stale.map((entry) => `${entry.file}: allows ${entry.allowed} ${entry.kind}, has ${entry.found}`),
        ...[...counts.keys()]
            .filter((file) => !HARNESS_GUARD_ALLOWLIST[file]?.why)
            .map((file) => `${file}: harness names outside the drivers, and its allowlist entry says no why`),
    ];
}

function main(): void {
    const args = new Set(process.argv.slice(2));
    const repoRoot = join(import.meta.dirname, "..", "..");
    let hits: HarnessGuardHit[];

    try {
        hits = scanRepo(repoRoot);
    } catch (error) {
        process.stderr.write(`harness-guard: scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
        return;
    }

    const counts = countsOf(hits);

    if (args.has("--update-allowlist")) {
        const named = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
        let merged: Map<string, HarnessGuardCounts>;

        try {
            merged = updateAllowlist(counts, HARNESS_GUARD_ALLOWLIST, named);
        } catch (error) {
            process.stderr.write(`harness-guard: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
            return;
        }

        writeFileSync(join(import.meta.dirname, "harness-guard-allowlist.ts"), renderAllowlist(merged));
        process.stdout.write(`harness-guard: updated ${named.length} entries, ${merged.size} files listed\n`);
        return;
    }

    if (args.has("--write-allowlist")) {
        for (const [file, entry] of counts) {
            const why = HARNESS_GUARD_ALLOWLIST[file]?.why;

            if (why) {
                counts.set(file, { ...entry, why });
            }
        }

        writeFileSync(join(import.meta.dirname, "harness-guard-allowlist.ts"), renderAllowlist(counts));
        process.stdout.write(`harness-guard: wrote ${counts.size} files, ${hits.length} sites\n`);
        return;
    }

    const verdict = compare(counts, HARNESS_GUARD_ALLOWLIST);
    const strict = HARNESS_GUARD_STRICT || args.has("--strict");
    const unjustified = [...counts.keys()].filter((file) => !HARNESS_GUARD_ALLOWLIST[file]?.why);

    if (strict && (verdict.added.length > 0 || verdict.stale.length > 0 || unjustified.length > 0)) {
        process.exitCode = 1;
    }

    if (args.has("--json")) {
        process.stdout.write(`${SafeJSON.stringify(hits, null, 2)}\n`);
        return;
    }

    const byKind = KINDS.map((kind) => `${hits.filter((hit) => hit.kind === kind).length} ${kind}`).join(", ");

    for (const entry of verdict.added) {
        process.stdout.write(
            `harness-guard: NEW ${entry.file} has ${entry.found} ${entry.kind} (allowed ${entry.allowed})\n`
        );

        for (const hit of hits.filter((h) => h.file === entry.file && h.kind === entry.kind)) {
            process.stdout.write(`    ${hit.file}:${hit.line}  ${hit.text}\n`);
        }
    }

    for (const entry of verdict.stale) {
        process.stdout.write(
            `harness-guard: STALE ${entry.file} allows ${entry.allowed} ${entry.kind}, has ${entry.found}: lower the allowlist\n`
        );
    }

    const unjustifiedSites = hits.filter((hit) => unjustified.includes(hit.file)).length;

    if (strict) {
        for (const file of unjustified) {
            process.stdout.write(`harness-guard: UNJUSTIFIED ${file}: move its sites into a driver part, or say why\n`);
        }
    }

    const mode = strict ? "strict" : "report";
    process.stdout.write(
        `harness-guard (${mode}): ${counts.size} files, ${hits.length} sites (${byKind}); ` +
            `${unjustifiedSites} sites in ${unjustified.length} files without a why; ` +
            `${verdict.added.length} new, ${verdict.stale.length} stale\n`
    );
}

if (import.meta.main) {
    main();
}
