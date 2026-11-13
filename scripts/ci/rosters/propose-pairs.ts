/**
 * The `pairs` source of the roster proposer: substitutions a git range made in many files.
 *
 * In each hunk (one contiguous block of removed and added lines in one file), the shapes only on the removed side and
 * the shapes only on the added side form (X → Y) pairs. A pair seen in N files means "X was replaced by Y in N files":
 * X is the pattern to keep out, and the module that declares Y owns it. A vanished shape alone proves nothing; a
 * shape that was swapped for the same replacement again and again is a pattern that moved.
 */
import { isTestPath, type Shape, shapeKey, shapesOf, type TreeUsage } from "./propose-shapes";

export interface PairStats {
    from: Shape;
    to: Shape;
    /** The files where a hunk replaced `from` with `to`. */
    files: Set<string>;
    /** Every file where a substitution hunk removed `from`, whatever replaced it (shared by all pairs of `from`). */
    fromFiles: Set<string>;
}

export interface PairCandidate {
    source: "pairs";
    key: string;
    from: Shape;
    to: Shape;
    /** Other replacements of `from` over exactly the same files (one refactor that added several calls). */
    alsoTo: Shape[];
    /** Files where a hunk replaced `from` with `to`. */
    files: number;
    /** `files` divided by the files where a substitution hunk removed `from` at all: how often X became this Y. */
    confidence: number;
    /** Tracked non-test files under src/ that still hold `from`. */
    remainingFiles: number;
    /** The file that declares `to`, or its module specifier for an import; null when nothing declares it. */
    owner: string | null;
    examples: string[];
}

/** A pair must hold at least this share of the files where its `from` was replaced. */
export const MIN_CONFIDENCE = 0.3;

/** A pair's `from` may still be in at most this many times as many files as the pair (else it is a common shape). */
export const MAX_PREVALENCE = 10;

/** A hunk with more distinct shapes than this on one side is a rewrite, not a substitution. */
export const MAX_HUNK_SHAPES = 8;

interface Hunk {
    file: string;
    removed: string[];
    added: string[];
}

/** The hunks of a unified diff (any context size): each `@@` block, split again at every context line. Pure. */
export function hunksOf(diff: string): Hunk[] {
    const hunks: Hunk[] = [];
    let file = "";
    let current: Hunk | null = null;

    const close = () => {
        if (current && (current.removed.length > 0 || current.added.length > 0)) {
            hunks.push(current);
        }

        current = null;
    };

    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("@@")) {
            close();
        }

        if (line.startsWith("+++ ")) {
            const next = line.slice(4).replace(/^b\//, "");
            file = next === "/dev/null" ? file : next;
            continue;
        }

        if (line.startsWith("--- ")) {
            const old = line.slice(4).replace(/^a\//, "");
            file = old === "/dev/null" ? "" : old;
            continue;
        }

        const removed = line.startsWith("-");
        const added = line.startsWith("+");

        if (!removed && !added) {
            close();
            continue;
        }

        current ??= { file, removed: [], added: [] };
        (removed ? current.removed : current.added).push(line.slice(1));
    }

    close();
    return hunks;
}

function distinctShapes(lines: readonly string[]): Map<string, Shape> {
    const shapes = new Map<string, Shape>();

    for (const line of lines) {
        for (const shape of shapesOf(line)) {
            shapes.set(shapeKey(shape), shape);
        }
    }

    return shapes;
}

/** The last name of a dotted callee: `fs.unlinkSync` → `unlinkSync`. */
function lastName(value: string): string {
    return value.split(".").at(-1) ?? value;
}

/**
 * A pair that only renamed: the same kind, and one side is the other plus a suffix (`load` → `loadSync`), or the same
 * last name under another receiver (`fs.unlinkSync` → `unlinkSync`). Pure.
 */
export function isRenameNoise(from: Shape, to: Shape): boolean {
    if (from.kind !== to.kind) {
        return false;
    }

    return (
        to.value.startsWith(from.value) ||
        from.value.startsWith(to.value) ||
        lastName(from.value) === lastName(to.value)
    );
}

/** Every (removed-only shape → added-only shape) pair, counted once per file. Pure. */
export function collectPairs(
    diff: string,
    skip: (file: string) => boolean,
    { maxShapes = MAX_HUNK_SHAPES }: { maxShapes?: number } = {}
): Map<string, PairStats> {
    const pairs = new Map<string, PairStats>();
    const fromFiles = new Map<string, Set<string>>();

    for (const hunk of hunksOf(diff)) {
        if (!hunk.file || skip(hunk.file) || hunk.removed.length === 0 || hunk.added.length === 0) {
            continue;
        }

        const removed = distinctShapes(hunk.removed);
        const added = distinctShapes(hunk.added);

        for (const key of [...removed.keys()]) {
            if (added.has(key)) {
                removed.delete(key);
                added.delete(key);
            }
        }

        if (removed.size === 0 || added.size === 0 || removed.size > maxShapes || added.size > maxShapes) {
            continue;
        }

        for (const [fromKey, from] of removed) {
            let removedIn = fromFiles.get(fromKey);

            if (!removedIn) {
                removedIn = new Set();
                fromFiles.set(fromKey, removedIn);
            }

            removedIn.add(hunk.file);

            for (const to of added.values()) {
                if (isRenameNoise(from, to)) {
                    continue;
                }

                const key = `${shapeKey(from)} -> ${shapeKey(to)}`;
                let found = pairs.get(key);

                if (!found) {
                    found = { from, to, files: new Set(), fromFiles: removedIn };
                    pairs.set(key, found);
                }

                found.files.add(hunk.file);
            }
        }
    }

    return pairs;
}

/**
 * The pairs worth a roster. A pair must be seen in at least `minFiles` files and hold at least `minConfidence` of the
 * files where its `from` was replaced at all. Its `from` must also be rare in today's tree: at most `maxPrevalence`
 * times as many files as the pair. A function collapsed into one helper call pairs every shape it held (`logger.debug`,
 * `existsSync`, `Bun.spawn`) with that helper; such a shape is still everywhere, the pattern that moved is not.
 * Pairs whose `from` is still in the tree come first (a roster has something to hold), then by files, then the rarer
 * `from`. Pairs of one `from` over the same files merge into one row (`alsoTo`). Pure apart from the injected lookups.
 */
export function rankPairs(
    pairs: Map<string, PairStats>,
    {
        minFiles,
        remaining,
        owner,
        limit = Number.POSITIVE_INFINITY,
        minConfidence = MIN_CONFIDENCE,
        maxPrevalence = MAX_PREVALENCE,
    }: {
        minFiles: number;
        remaining: (shape: Shape) => TreeUsage;
        owner: (shape: Shape) => string | null;
        limit?: number;
        minConfidence?: number;
        maxPrevalence?: number;
    }
): PairCandidate[] {
    const ranked = [...pairs.entries()]
        .filter(([, pair]) => pair.files.size >= minFiles && pair.files.size / pair.fromFiles.size >= minConfidence)
        .map(([key, pair]) => ({ key, pair, left: remaining(pair.from).files }))
        .filter(({ pair, left }) => left <= pair.files.size * maxPrevalence)
        .sort(
            (a, b) =>
                Number(b.left > 0) - Number(a.left > 0) ||
                b.pair.files.size - a.pair.files.size ||
                a.left - b.left ||
                a.key.localeCompare(b.key)
        );

    const rows: PairCandidate[] = [];
    const byGroup = new Map<string, PairCandidate>();

    for (const { key, pair, left } of ranked) {
        const files = [...pair.files].sort();
        const group = `${shapeKey(pair.from)} ${files.join(" ")}`;
        const merged = byGroup.get(group);

        if (merged) {
            merged.alsoTo.push(pair.to);
            continue;
        }

        if (rows.length >= limit) {
            continue;
        }

        const row: PairCandidate = {
            source: "pairs",
            key,
            from: pair.from,
            to: pair.to,
            alsoTo: [],
            files: pair.files.size,
            confidence: Math.round((pair.files.size / pair.fromFiles.size) * 100) / 100,
            remainingFiles: left,
            owner: owner(pair.to),
            examples: files.slice(0, 3),
        };
        byGroup.set(group, row);
        rows.push(row);
    }

    return rows;
}

/** A `git grep -P` of the declaration of a name; the files that hold it, exported ones first. */
function declaringFiles(pattern: string): string[] {
    const grep = Bun.spawnSync(["git", "grep", "-l", "-P", "-e", pattern, "--", "src/*.ts", "src/*.tsx"]);

    if (grep.exitCode !== 0 && grep.exitCode !== 1) {
        throw new Error(`git grep failed: ${grep.stderr.toString()}`);
    }

    return grep.stdout
        .toString()
        .split("\n")
        .filter((file) => file && !isTestPath(file));
}

const ownerCache = new Map<string, string | null>();

/**
 * The file that declares a shape (a function, const or class of that name, exported declarations first, the shared
 * package first), or the module specifier itself for an import. Null when no tracked file declares it.
 */
export function ownerOfShape(shape: Shape): string | null {
    if (shape.kind === "import") {
        return shape.value;
    }

    // A method of `this` belongs to the class the hunk is in; an argv head or a file name has no declaration.
    if (shape.kind === "argv" || shape.kind === "literal" || shape.value.startsWith("this.")) {
        return null;
    }

    const key = shapeKey(shape);

    if (ownerCache.has(key)) {
        return ownerCache.get(key) ?? null;
    }

    const name = lastName(shape.value).replace(/\$/g, "\\$");
    const declaration =
        shape.kind === "new"
            ? `class\\s+${name}\\b`
            : `(?:function\\*?\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*[=:]|class\\s+${name}\\b)`;
    const exported = declaringFiles(`^\\s*export\\s+(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?${declaration}`);
    const files = exported.length > 0 ? exported : declaringFiles(declaration);
    const owner = [...files].sort((a, b) => Number(b.startsWith("src/utils/")) - Number(a.startsWith("src/utils/")))[0];
    ownerCache.set(key, owner ?? null);
    return owner ?? null;
}
