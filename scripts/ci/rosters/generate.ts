#!/usr/bin/env bun
/**
 * Finds every file that still holds a roster's pattern and writes the counts into `rosters.json`.
 *
 *   bun scripts/ci/rosters/generate.ts            # lower counts and drop clean files; seed a roster with no entry
 *   bun scripts/ci/rosters/generate.ts --check    # write nothing; exit 1 when the manifest differs from the tree
 *   bun scripts/ci/rosters/generate.ts --base origin/master   # also exit 1 when the manifest grew against that ref
 *   bun scripts/ci/rosters/generate.ts --only roster-ado-fetch-outside-api
 *   bun scripts/ci/rosters/generate.ts --check --tree   # only the tree rosters (`tree.ts`): the pre-push and CI guard
 *
 * A roster only shrinks. A file that gained a match, or a new file with one, is printed and NOT written: fix the code,
 * or add `// lint-rules-ignore: <why>` on the line. Only a roster the manifest does not have yet (a new definition)
 * is seeded with what the tree holds today.
 *
 * Exit 2, with the reason and nothing written, when an input cannot be read: the tracked-file list, or a `--base` ref
 * that is unknown or not fetched. A base commit from before the manifest existed is no error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { findInFiles, type SgNode } from "@ast-grep/napi";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    groupByLang,
    isSuppressed,
    isTestFile,
    maskSwiftNonCode,
    pluginsDisabledFor,
    targetFiles,
} from "../lint-rules";
import { spawnWithDeadline } from "../spawn-deadline";
import type { RosterDefinition } from "./define";
import { parseRosters, ROSTER_DEFINITIONS, ROSTERS_FILE, type Rosters, readRosters, rosterGrowth } from "./index";
import { SWIFT_ROSTERS, type SwiftRoster, swiftRosterApplies, swiftRosterLines } from "./swift";
import { countByKey, notSuppressed, TREE_ROSTERS, type TreeMatch, treeInventory } from "./tree";

export interface RosterMatch {
    file: string;
    line: number;
    text: string;
}

/** The files a roster covers: the lint's own file set, minus tests and the files biome keeps plugins off. */
export function rosterFiles(definition: RosterDefinition, files: readonly string[]): string[] {
    return files.filter(
        (file) =>
            !isTestFile(file) &&
            !pluginsDisabledFor(file) &&
            (definition.onlyIn?.test(file) ?? true) &&
            !(definition.allowedIn?.test(file) ?? false) &&
            !file.endsWith(".swift")
    );
}

/** Every match of one roster's pattern, suppressed lines left out. */
export async function scanRoster(definition: RosterDefinition, files: readonly string[]): Promise<RosterMatch[]> {
    const byLang = groupByLang(rosterFiles(definition, files));
    const nodes: SgNode[] = [];

    for (const [lang, paths] of byLang) {
        await findInFiles(lang, { paths, matcher: definition.matcher }, (error, found) => {
            if (error) {
                throw error;
            }

            nodes.push(...found);
        });
    }

    const lines = new Map<string, string[]>();
    const matches: RosterMatch[] = [];

    for (const node of nodes) {
        if (definition.test && !definition.test(node)) {
            continue;
        }

        const file = node.getRoot().filename();
        const line = node.range().start.line + 1;

        if (!lines.has(file)) {
            lines.set(file, readFileSync(file, "utf8").split("\n"));
        }

        if (isSuppressed(lines.get(file) ?? [], line)) {
            continue;
        }

        matches.push({ file, line, text: node.text().split("\n")[0].slice(0, 100) });
    }

    return matches;
}

/** Every line of the Swift files that holds one of `rosters`' patterns; each file is read and masked once. */
export function scanSwiftRosters(
    rosters: readonly SwiftRoster[],
    files: readonly string[],
    read: (file: string) => string = (file) => readFileSync(file, "utf8")
): Map<string, RosterMatch[]> {
    const matches = new Map<string, RosterMatch[]>(rosters.map((roster) => [roster.name, []]));

    for (const file of files) {
        const applying = rosters.filter((roster) => swiftRosterApplies(roster, file));

        if (applying.length === 0) {
            continue;
        }

        const source = read(file);
        const lines = source.split("\n");
        const masks = {
            code: maskSwiftNonCode(source).split("\n"),
            withStrings: maskSwiftNonCode(source, { keepStrings: true }).split("\n"),
        };

        for (const roster of applying) {
            for (const hit of swiftRosterLines(roster, masks, (line) => isSuppressed(lines, line))) {
                matches
                    .get(roster.name)
                    ?.push({ file, line: hit.line, text: (lines[hit.line - 1] ?? "").trim().slice(0, 100) });
            }
        }
    }

    return matches;
}

export function countByFile(matches: readonly RosterMatch[]): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const match of [...matches].sort((a, b) => a.file.localeCompare(b.file))) {
        counts[match.file] = (counts[match.file] ?? 0) + 1;
    }

    return counts;
}

export interface RosterPlan {
    /** What the manifest becomes: every count lowered to what the tree holds, a new roster seeded. */
    next: Rosters;
    /** Files over their roster count, or new files with a match: the lint fails on these. */
    grown: string[];
    /** Entries that went down or left: the manifest is stale until it is written. */
    shrunk: string[];
}

/** Pure: the manifest after one scan. A known roster never takes a count above its listed one. */
export function planRosters(current: Rosters, found: Record<string, Record<string, number>>): RosterPlan {
    const next: Rosters = {};
    const grown: string[] = [];
    const shrunk: string[] = [];

    for (const [name, counts] of Object.entries(found)) {
        const listed = current[name];

        if (!listed) {
            next[name] = counts;
            continue;
        }

        next[name] = {};

        for (const [file, count] of Object.entries(counts)) {
            const allowed = listed[file] ?? 0;

            if (count > allowed) {
                grown.push(`${name}: ${file} has ${count}, the roster allows ${allowed}`);
            }

            const kept = Math.min(count, allowed);

            if (kept > 0) {
                next[name][file] = kept;
            }
        }

        for (const [file, allowed] of Object.entries(listed)) {
            if ((next[name][file] ?? 0) < allowed) {
                shrunk.push(`${name}: ${file} ${allowed} → ${next[name][file] ?? 0}`);
            }
        }
    }

    return { next, grown, shrunk };
}

function serialize(rosters: Rosters): string {
    const sorted: Rosters = {};

    for (const name of Object.keys(rosters).sort()) {
        sorted[name] = rosters[name];
    }

    return `${SafeJSON.stringify(sorted, null, 4)}\n`;
}

/**
 * The manifest at `base`, or null when that commit predates it: a manifest that did not exist cannot have been edited
 * up. An unknown or unfetched ref, a stalled git (killed at its deadline) or any other git failure throws, so a
 * baseline check never passes unread.
 */
export function baseRosters(base: string, { cwd = process.cwd() }: { cwd?: string } = {}): Rosters | null {
    const git = (args: string[], what: string): string => {
        const run = spawnWithDeadline(["git", ...args], { cwd });

        if (run.exitCode !== 0) {
            throw new Error(`rosters: cannot ${what} (git exited ${run.exitCode}): ${run.stderr.toString().trim()}`);
        }

        return run.stdout.toString();
    };
    const commit = git(["rev-parse", "--verify", `${base}^{commit}`], `read --base ${base}`).trim();

    if (git(["ls-tree", "--name-only", commit, "--", ROSTERS_FILE], `list ${ROSTERS_FILE} at ${base}`).trim() === "") {
        return null;
    }

    return parseRosters(git(["show", `${commit}:${ROSTERS_FILE}`], `read ${ROSTERS_FILE} at ${base}`));
}

function argValue(flag: string): string | undefined {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
    const check = process.argv.includes("--check");
    const only = argValue("--only");
    const base = argValue("--base");
    const treeOnly = process.argv.includes("--tree");
    const definitions = treeOnly ? [] : ROSTER_DEFINITIONS.filter((definition) => !only || definition.name === only);
    const trees = TREE_ROSTERS.filter((tree) => !only || tree.name === only);
    const swift = treeOnly ? [] : SWIFT_ROSTERS.filter((roster) => !only || roster.name === only);

    if (definitions.length === 0 && trees.length === 0 && swift.length === 0) {
        console.error(`rosters: no roster named ${only}`);
        process.exit(2);
    }

    // A scan that cannot read its input stops with the reason and writes nothing: an empty file list would drop every
    // count, and an unread base would pass a manifest edited up.
    const abort = (error: unknown): never => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
    };
    let baseline: Rosters | null = null;

    try {
        baseline = base ? baseRosters(base) : null;
    } catch (error) {
        abort(error);
    }

    const files = await targetFiles().catch(abort);
    const current = readRosters();
    const found: Record<string, Record<string, number>> = {};

    for (const definition of definitions) {
        const matches = await scanRoster(definition, files);
        found[definition.name] = countByFile(matches);
        console.log(
            `${definition.name} (${definition.candidate}): ${matches.length} in ${Object.keys(found[definition.name]).length} files`
        );
    }

    for (const [name, matches] of scanSwiftRosters(swift, files)) {
        found[name] = countByFile(matches);
        console.log(`${name}: ${matches.length} in ${Object.keys(found[name]).length} files`);
    }

    // The tree rosters read every source file once, whatever the lint was asked to look at: a copy is a copy of
    // a file that did not change.
    const treeMatches = new Map<string, TreeMatch[]>();

    if (trees.length > 0) {
        const inventory = await treeInventory(files);
        const kept = notSuppressed();

        for (const tree of trees) {
            const matches = tree.scan(inventory, kept);

            treeMatches.set(tree.name, matches);
            found[tree.name] = countByKey(matches);
            console.log(
                `${tree.name} (${tree.candidate}): ${matches.length} in ${Object.keys(found[tree.name]).length} entries`
            );
        }
    }

    const plan = planRosters(current, found);
    const known = new Set([...ROSTER_DEFINITIONS, ...TREE_ROSTERS, ...SWIFT_ROSTERS].map((roster) => roster.name));
    const unknown = Object.keys(current).filter((name) => !known.has(name));
    const next: Rosters = { ...current, ...plan.next };

    for (const name of unknown) {
        delete next[name];
    }

    const problems = [...plan.grown.map((line) => `grew: ${line}`)];

    if (baseline) {
        problems.push(...rosterGrowth(baseline, current).map((l) => `edited up: ${l}`));
    }

    const changed = serialize(next) !== serialize(current);

    for (const line of problems) {
        console.log(line);
    }

    // What grew in a tree roster, match by match: the manifest line alone does not say which function it is.
    for (const tree of trees) {
        const listed = current[tree.name];
        const over = (treeMatches.get(tree.name) ?? []).filter(
            (match) => listed !== undefined && (found[tree.name]?.[match.key] ?? 0) > (listed[match.key] ?? 0)
        );

        for (const match of over) {
            console.log(`  ${match.file}:${match.line}  ${match.detail}`);
        }

        if (over.length > 0) {
            console.log(`  ${tree.name}: ${tree.message}`);
        }
    }

    if (check) {
        if (changed) {
            console.log(`${ROSTERS_FILE} is stale; run bun scripts/ci/rosters/generate.ts`);
            for (const line of plan.shrunk) {
                console.log(`  shrank: ${line}`);
            }
        }

        process.exit(problems.length > 0 || changed ? 1 : 0);
    }

    if (changed) {
        writeFileSync(ROSTERS_FILE, serialize(next));
        console.log(`wrote ${ROSTERS_FILE}`);
    }

    process.exit(problems.length > 0 ? 1 : 0);
}
