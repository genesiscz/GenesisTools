/**
 * Tree rosters: guards that need the whole tree at once, where a pattern roster looks at one file.
 *
 * A pattern roster stops `fetch(` beside `Api.send`. It cannot stop the next `myParseTranscript`: a helper that
 * a shared module already exports, written again under the same name, under a new name, or reached through an
 * import that crosses a boundary nobody crossed before. Each of those is only visible against the other files:
 *
 *   roster-shared-export-redeclared   a function named like an export of `src/utils/**` (a copy affix removed:
 *                                     `myParseTranscript`, `parseTranscriptLocal`, `parseTranscript2`), declared
 *                                     outside its owner.
 *   roster-function-body-copied       a function whose body is the body of a `src/utils/**` export, whatever its
 *                                     name and whatever its parameters are called.
 *   roster-tool-dependency-added      a tool imports another tool it did not import before (or `src/utils` imports
 *                                     a tool): a new edge in the tool graph. Its manifest key is `from → to`.
 *
 * They share the manifest and its rule with the pattern rosters (`rosters.json`, a count only goes down), and
 * `generate.ts` writes and checks them. They are NOT in `lint-rules.ts`: one file cannot be judged alone, and the
 * inventory reads every source file. Measured 2026-11-12 on 7,522 files and 36,839 named functions: 5,157 function
 * names are exported from `src/utils/**`; 372 of them are declared again elsewhere (1,117 copies), and the body of
 * 42 of them exists elsewhere 186 times, 29 of those under another name (`isObject` as `isRecord`, `isPlainObject`,
 * `isJsonRecord`).
 */
import { readFileSync } from "node:fs";
import {
    buildInventory,
    copyNames,
    type FunctionFact,
    type Inventory,
    isDistinctName,
    nearest,
} from "@app/ts/lib/inventory";
import { isSuppressed, isTestFile, pluginsDisabledFor } from "../lint-rules";

export interface TreeMatch {
    /** The manifest key: the file, or for a dependency `from → to`. */
    key: string;
    file: string;
    line: number;
    /** What this match copies or crosses; it leads the printed line. */
    detail: string;
}

/** Whether a fact at this file and line may become a match: its line carries no `lint-rules-ignore`. */
export type KeptLine = (file: string, line: number) => boolean;

export interface TreeRoster {
    name: string;
    candidate: string;
    message: string;
    /**
     * The matches of the tree. `kept` filters each fact before it becomes a match, so a roster that collapses several
     * facts into one entry (a dependency is one entry per pair of tools) picks its entry among the unsuppressed ones.
     */
    scan: (inventory: Inventory, kept: KeptLine) => TreeMatch[];
}

/**
 * The files a tree roster reads: the lint's set, minus tests, declaration files, what biome keeps plugins off, and
 * `plugins/`. A plugin file is copied out of this checkout and cannot import `src/utils`, so its own `isRecord` is
 * the rule there, not a copy (`.claude/rules/plugins.md`, `check-plugin-standalone.ts`).
 */
export function treeFiles(files: readonly string[]): string[] {
    return files.filter(
        (file) =>
            !file.startsWith("plugins/") &&
            /\.(?:ts|tsx|mts|cts)$/.test(file) &&
            !file.endsWith(".d.ts") &&
            !isTestFile(file) &&
            !pluginsDisabledFor(file)
    );
}

/** The inventory of the files a tree roster reads. */
export function treeInventory(files: readonly string[]): Promise<Inventory> {
    return buildInventory(treeFiles(files));
}

const isShared = (file: string) => file.startsWith("src/utils/");

/** Two words or more, and long enough: `walk`, `text`, `git` and `count` are exported from utils and mean nothing alone. */
function sharedExports(inventory: Inventory): Map<string, FunctionFact[]> {
    const owners = new Map<string, FunctionFact[]>();

    for (const fact of inventory.functions) {
        if (fact.exported && isShared(fact.file)) {
            owners.set(fact.name, [...(owners.get(fact.name) ?? []), fact]);
        }
    }

    return owners;
}

export const SHARED_EXPORT_REDECLARED: TreeRoster = {
    name: "roster-shared-export-redeclared",
    candidate: "D16",
    message:
        "This function has the name of a helper that src/utils already exports. Import the shared one; when it lacks " +
        "what you need, extend it there.",
    scan: (inventory, kept) => {
        const owners = sharedExports(inventory);
        const matches: TreeMatch[] = [];

        for (const fact of inventory.functions) {
            if (!kept(fact.file, fact.line)) {
                continue;
            }

            for (const candidate of copyNames(fact.name)) {
                const owned = owners.get(candidate);

                if (!owned || !isDistinctName(candidate) || owned.some((owner) => owner.file === fact.file)) {
                    continue;
                }

                // An export of utils under its own name in another utils file is a second owner, not a copy.
                if (candidate === fact.name && fact.exported && isShared(fact.file)) {
                    continue;
                }

                matches.push({
                    key: fact.file,
                    file: fact.file,
                    line: fact.line,
                    detail: `${fact.name}: ${candidate === fact.name ? "" : `a renamed copy of ${candidate}, `}exported from ${[...owned].sort(nearest)[0]?.file}`,
                });
                break;
            }
        }

        return matches;
    },
};

export const FUNCTION_BODY_COPIED: TreeRoster = {
    name: "roster-function-body-copied",
    candidate: "D16",
    message:
        "This function's body is the body of a helper that src/utils exports, under this or another name. Import " +
        "the shared one instead of the copy.",
    scan: (inventory, kept) => {
        const owners = new Map<string, FunctionFact>();

        for (const fact of inventory.functions) {
            const held = fact.fingerprint ? owners.get(fact.fingerprint) : undefined;

            if (fact.fingerprint && fact.exported && isShared(fact.file) && (!held || nearest(fact, held) < 0)) {
                owners.set(fact.fingerprint, fact);
            }
        }

        const matches: TreeMatch[] = [];

        for (const fact of inventory.functions) {
            const owner = fact.fingerprint ? owners.get(fact.fingerprint) : undefined;

            // Another export of utils with the same body is utils' own matter (two owners), not a tool's copy.
            if (!owner || owner.file === fact.file || (fact.exported && isShared(fact.file))) {
                continue;
            }

            if (!kept(fact.file, fact.line)) {
                continue;
            }

            matches.push({
                key: fact.file,
                file: fact.file,
                line: fact.line,
                detail: `${fact.name}: the body of ${owner.name} (${owner.file}:${owner.line})`,
            });
        }

        return matches;
    },
};

/**
 * The tool a path belongs to: the first folder under `src/` (`src/hub/lib/a.ts` and the import target `src/hub` are
 * both `hub`). A single-file tool (`src/x.ts`) has none here.
 */
export function toolOf(path: string): string | null {
    const first = /^src\/([^/]+)(\/)?/.exec(path);

    if (!first?.[1] || (first[2] === undefined && /\.[a-z]+$/.test(first[1]))) {
        return null;
    }

    return first[1];
}

export const TOOL_DEPENDENCY_ADDED: TreeRoster = {
    name: "roster-tool-dependency-added",
    candidate: "D16",
    message:
        "This import makes one tool depend on another tool for the first time (or src/utils on a tool). Move what " +
        "you need into src/utils and import it from there; a dependency between two tools that is wanted gets " +
        "`// lint-rules-ignore: <why>` on the import.",
    scan: (inventory, kept) => {
        const first = new Map<string, TreeMatch>();

        for (const fact of inventory.imports) {
            const from = toolOf(fact.file);
            const to = toolOf(fact.target);

            // Everything may import utils; an import inside one tool is no edge.
            if (!from || !to || from === to || to === "utils") {
                continue;
            }

            const key = `${from} → ${to}`;

            // A suppressed import exempts itself only: the pair's entry is its first import without the comment.
            if (!first.has(key) && kept(fact.file, fact.line)) {
                first.set(key, { key, file: fact.file, line: fact.line, detail: `${key}: ${fact.target}` });
            }
        }

        return [...first.values()];
    },
};

export const TREE_ROSTERS: readonly TreeRoster[] = [
    SHARED_EXPORT_REDECLARED,
    FUNCTION_BODY_COPIED,
    TOOL_DEPENDENCY_ADDED,
];

/**
 * The `kept` of a scan: a line that carries no `lint-rules-ignore` (on it or the line above). Each file is read once.
 * `read` is injected so a test needs no files.
 */
export function notSuppressed(read: (file: string) => string = (file) => readFileSync(file, "utf8")): KeptLine {
    const lines = new Map<string, string[]>();

    return (file, line) => {
        if (!lines.has(file)) {
            lines.set(file, read(file).split("\n"));
        }

        return !isSuppressed(lines.get(file) ?? [], line);
    };
}

export function countByKey(matches: readonly TreeMatch[]): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const match of [...matches].sort((a, b) => a.key.localeCompare(b.key))) {
        counts[match.key] = (counts[match.key] ?? 0) + 1;
    }

    return counts;
}
