import { hashDeclaration, type SkeletonSymbol, tokenizeDeclaration } from "./skeleton";

export interface FileSymbols {
    /** Repo-relative, because it is what every report prints. */
    file: string;
    text: string;
    symbols: SkeletonSymbol[];
}

export interface DuplicateMember {
    file: string;
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    lines: number;
    exported: boolean;
    local: boolean;
    signature: string;
    hash: string;
}

/** `identical` means the fingerprints match exactly; `near` means they matched on similarity. */
export type DuplicateReason = "identical" | "near";

export interface DuplicateGroup {
    id: string;
    reason: DuplicateReason;
    /** The lowest similarity any member has against the group's representative. */
    similarity: number;
    names: string[];
    copies: number;
    /** Lines in the largest member. */
    lines: number;
    /** What collapsing the group to one definition would remove. */
    wastedLines: number;
    score: number;
    members: DuplicateMember[];
    /** The copy that should survive, once `recommend` is on. */
    canonical: DuplicateMember | null;
    action: string | null;
    /** True when the repetition looks deliberate rather than accidental. */
    pattern: boolean;
    patternReason: string | null;
}

export interface NameCollision {
    name: string;
    kind: string;
    members: DuplicateMember[];
}

export interface DuplicateReport {
    groups: DuplicateGroup[];
    /** Same name, different code. Only filled when `nameCollisions` is on. */
    collisions: NameCollision[];
    scanned: { files: number; symbols: number; candidates: number; pairs: number };
    suppressed: { patterns: number; tooSmall: number; sameFile: number; oversizedBuckets: number };
}

export interface DuplicateOptions {
    /** A declaration shorter than this is never a finding. Default 3. */
    minLines?: number;
    /** Jaccard floor for a `near` group. Default 0.8. */
    similarity?: number;
    /** Report the deliberate repeated shapes too. Default false. */
    includePatterns?: boolean;
    /** Report a group whose copies all live in one file. Default false. */
    includeSameFile?: boolean;
    /** Also list same-name-different-code pairs. Default false. */
    nameCollisions?: boolean;
    /** Restrict to these declaration kinds. Default: the code-bearing ones. */
    kinds?: string[];
    /** Pick a canonical copy and write the edit that removes the others. Default false. */
    recommend?: boolean;
    /** Path segments that mark a shared home, used to pick the canonical copy. */
    sharedDirs?: string[];
}

const DEFAULT_KINDS = ["function", "method", "class", "interface", "type", "enum", "const"];
/** Path segments that mark a module as the shared home for a helper. */
export const SHARED_DIRS = ["utils", "util", "lib", "shared", "common", "core", "helpers"];
const SHINGLE_SIZE = 4;
const HASH_COUNT = 64;
const BANDS = 16;
const ROWS = HASH_COUNT / BANDS;
/**
 * A band bucket this large is a shape the codebase repeats on purpose, and every pair in it
 * costs a set intersection. Comparing them all turned a 0.9 s run into minutes on a sibling repo's
 * 48 page objects plus their neighbours, and the groups it produced were all patterns anyway.
 */
const MAX_BUCKET = 800;

function fnv1a(value: string): number {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}

/** Overlapping token windows. A short declaration becomes one shingle rather than none. */
function shinglesOf(tokens: string[]): Set<number> {
    if (tokens.length === 0) {
        return new Set();
    }

    if (tokens.length <= SHINGLE_SIZE) {
        return new Set([fnv1a(tokens.join("\u0001"))]);
    }

    const shingles = new Set<number>();

    for (let index = 0; index + SHINGLE_SIZE <= tokens.length; index += 1) {
        shingles.add(fnv1a(tokens.slice(index, index + SHINGLE_SIZE).join("\u0001")));
    }

    return shingles;
}

/**
 * A MinHash signature, built from two base hashes rather than 64 independent ones. `h1 + i*h2`
 * is the standard cheap family and is accurate enough for a similarity floor.
 */
function signatureOf(shingles: Set<number>): Uint32Array {
    const signature = new Uint32Array(HASH_COUNT).fill(0xffffffff);

    for (const shingle of shingles) {
        const first = shingle >>> 0;
        const second = (fnv1a(String(shingle)) | 1) >>> 0;

        for (let index = 0; index < HASH_COUNT; index += 1) {
            const value = (first + Math.imul(index, second)) >>> 0;

            if (value < signature[index]!) {
                signature[index] = value;
            }
        }
    }

    return signature;
}

function jaccard(left: Set<number>, right: Set<number>): number {
    if (left.size === 0 || right.size === 0) {
        return left.size === right.size ? 1 : 0;
    }

    const [small, large] = left.size <= right.size ? [left, right] : [right, left];
    let shared = 0;

    for (const value of small) {
        if (large.has(value)) {
            shared += 1;
        }
    }

    return shared / (left.size + right.size - shared);
}

interface Candidate {
    member: DuplicateMember;
    shingles: Set<number>;
    signature: Uint32Array;
}

/**
 * How alike two declarations are, from 0 to 1, on the same measure the grouping uses. Exposed
 * so an analyser can quote the number as evidence without rebuilding the shingles itself.
 */
export function declarationSimilarity(
    left: { text: string; name: string },
    right: { text: string; name: string }
): number {
    return jaccard(
        shinglesOf(tokenizeDeclaration(left.text, left.name)),
        shinglesOf(tokenizeDeclaration(right.text, right.name))
    );
}

function directoryOf(file: string): string {
    const cut = file.lastIndexOf("/");

    return cut === -1 ? "" : file.slice(0, cut);
}

function commonPrefix(paths: string[]): string {
    if (paths.length === 0) {
        return "";
    }

    const split = paths.map((path) => directoryOf(path).split("/"));
    const first = split[0] ?? [];
    let depth = 0;

    while (depth < first.length && split.every((parts) => parts[depth] === first[depth])) {
        depth += 1;
    }

    return first.slice(0, depth).join("/");
}

/**
 * True when the file names share a stem of four or more letters at the start or the end, so they
 * read as one family: `LandingScreen.ts` and `BillingScreen.ts`, or `StoreOrders.ts` and
 * `StoreUsers.ts`.
 *
 * 🛑 The stems must differ, and a convention suffix is not a stem. Four `index.ts` files share all
 * five letters, and `api.types.ts` / `user.types.ts` share `.types`, so both used to read as a
 * family and hid real copy-paste in exactly the files where it collects. A role suffix that names
 * the family (`header.component.ts`, `billing.screen.ts`) is kept.
 */
function isNamingFamily(files: string[]): boolean {
    const stems = [
        ...new Set(
            files.map((file) =>
                file
                    .slice(file.lastIndexOf("/") + 1)
                    .replace(/\.[cm]?[jt]sx?$/, "")
                    .replace(/\.(test|spec|types|d)$/, "")
            )
        ),
    ];

    if (stems.length < 2) {
        return false;
    }

    const reversed = stems.map((stem) => [...stem].reverse().join(""));
    const sharedStart = (words: string[]): number => {
        const first = words[0] ?? "";
        let length = 0;

        while (length < first.length && words.every((word) => word[length] === first[length])) {
            length += 1;
        }

        return length;
    };

    return Math.max(sharedStart(stems), sharedStart(reversed)) >= 4;
}

/**
 * Repetition the authors meant, rather than a copy-paste defect. Three shapes qualify, and each
 * needs its own evidence that the copies form a family: a subtree below the scan root, file names
 * that differ only by number, or file names built on one stem.
 *
 * 🛑 Directory alone is NOT enough, and trying it first is what produced the noise this
 * function exists to remove. Measured 2026-09-22 on a sibling repo: `requireToken` is copied five
 * times inside `src/gitlab/commands/` and is a real defect, while `waitForVisible` is
 * implemented by 50 page objects under `src/e2e/mobile/pages/` and is a base class waiting to
 * happen. What separates them is the shape of the declaration and whether the copies were
 * given their own names.
 */
function patternReasonOf(members: DuplicateMember[], scanRoot: string): string | null {
    const files = members.map((member) => member.file);
    const shared = commonPrefix(files);

    if (shared === "") {
        return null;
    }

    const distinctNames = new Set(members.map((member) => member.name)).size === members.length;
    const sameDirectory = new Set(files.map((file) => directoryOf(file))).size === 1;
    const allMethods = members.every((member) => member.kind === "method");

    // A numbered family: `40302.e2e.ts` beside `40303.e2e.ts`, one file per test case, per
    // migration, per fixture. Strip the digits and the names are the same file. Two copies is
    // enough here, because the file names themselves say the repetition was the plan.
    if (sameDirectory && distinctNames) {
        const stems = new Set(files.map((file) => file.slice(file.lastIndexOf("/") + 1).replace(/\d+/g, "") || file));

        if (stems.size === 1) {
            return `${members.length} files in ${shared}/ whose names differ only by number`;
        }
    }

    // A method the whole family implements. The fix is a base class or a mixin, which is a
    // design decision, not the import this report would otherwise recommend.
    //
    // 🛑 "A family" needs evidence: the copies sit below the scan root, or their files are named
    // as one (`*Screen.ts`, `*Page.ts`). Without that, four unrelated classes that each pasted
    // the same `save()` were hidden as a pattern, because every file shares SOME parent.
    if (allMethods && members.length >= 4 && (shared.length > scanRoot.length || isNamingFamily(files))) {
        return `${members.length} classes under ${shared}/ implement this method`;
    }

    // Parallel implementations, each given its own name: one per screen, per scenario, per
    // route. Four across a subtree, or three inside one directory.
    //
    // ⚠️ This is the weakest of the three, so it needs family evidence on top of the distinct
    // names: a subtree below the scan root, or file names built on one stem. Without that,
    // scanning one directory would call every differently named group in it deliberate, and
    // `--kinds` plus a narrow path is exactly how somebody drills into a directory they suspect.
    if (
        distinctNames &&
        (shared.length > scanRoot.length || isNamingFamily(files)) &&
        (members.length >= 4 || (members.length >= 3 && sameDirectory))
    ) {
        return `${members.length} differently named copies, all under ${shared}/`;
    }

    return null;
}

/** A vendored or generated copy is never the home a reader should import from. */
const DERIVED_SEGMENTS = ["vendor", "vendored", "generated", "__generated__", "node_modules", "dist"];

function isDerived(file: string): boolean {
    return file.split("/").some((segment) => DERIVED_SEGMENTS.includes(segment));
}

function isShared(file: string, sharedDirs: string[]): boolean {
    return file.split("/").some((segment) => sharedDirs.includes(segment));
}

/**
 * The copy that should survive. Exported beats private, a shared directory beats a feature
 * directory, and the longest body beats a trimmed-down one, in that order.
 */
function pickCanonical(members: DuplicateMember[], sharedDirs: string[]): DuplicateMember {
    return [...members].sort((left, right) => {
        const leftDerived = isDerived(left.file);
        const rightDerived = isDerived(right.file);

        // A vendored copy loses first, whatever else it has going for it. Recommending that
        // the repo import from its own `vendor/` tree inverts which file is the source.
        if (leftDerived !== rightDerived) {
            return leftDerived ? 1 : -1;
        }

        if (left.exported !== right.exported) {
            return left.exported ? -1 : 1;
        }

        const leftShared = isShared(left.file, sharedDirs);
        const rightShared = isShared(right.file, sharedDirs);

        if (leftShared !== rightShared) {
            return leftShared ? -1 : 1;
        }

        if (left.lines !== right.lines) {
            return right.lines - left.lines;
        }

        return left.file.localeCompare(right.file);
    })[0] as DuplicateMember;
}

function actionFor(
    group: Omit<DuplicateGroup, "action" | "score">,
    canonical: DuplicateMember,
    sharedDirs: string[]
): string {
    const others = group.members.filter((member) => member !== canonical);
    const renames = others.filter((member) => member.name !== canonical.name).length;
    const steps: string[] = [];

    // 🛑 When no copy already lives in a shared module, pointing the others at the "best" copy
    // tells them to import from a command file or a feature file, which is how the duplication
    // started. Say so, and name where the shared home belongs instead.
    if (!isShared(canonical.file, sharedDirs)) {
        const home = commonPrefix(group.members.map((member) => member.file)) || ".";

        steps.push(
            `no copy lives in a shared module: move the body of ${canonical.file}:${canonical.startLine} into one ` +
                `under ${home}/ and import it in all ${group.members.length} files`
        );
    } else {
        if (!canonical.exported) {
            steps.push(`export \`${canonical.name}\` from ${canonical.file}`);
        }

        steps.push(
            `import \`${canonical.name}\` from ${canonical.file} in ${others.length} file${others.length === 1 ? "" : "s"}` +
                ` and delete the local cop${others.length === 1 ? "y" : "ies"}`
        );
    }

    if (renames > 0) {
        steps.push(`${renames} of them use another name, so rename at the call sites`);
    }

    if (group.similarity < 1) {
        steps.push("the copies differ, so reconcile the behaviour before deleting");
    }

    return steps.join("; ");
}

export function findDuplicates(entries: FileSymbols[], options: DuplicateOptions = {}): DuplicateReport {
    const minLines = options.minLines ?? 3;
    const threshold = options.similarity ?? 0.8;
    const kinds = new Set(options.kinds ?? DEFAULT_KINDS);
    const sharedDirs = options.sharedDirs ?? SHARED_DIRS;
    const scanRoot = commonPrefix(entries.map((entry) => entry.file));

    const candidates: Candidate[] = [];
    let symbols = 0;
    let tooSmall = 0;

    for (const entry of entries) {
        const lines = entry.text.split("\n");

        for (const symbol of entry.symbols) {
            symbols += 1;

            if (!kinds.has(symbol.kind)) {
                continue;
            }

            const span = symbol.endLine - symbol.startLine + 1;

            if (span < minLines) {
                tooSmall += 1;
                continue;
            }

            const declaration = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
            const shingles = shinglesOf(tokenizeDeclaration(declaration, symbol.name));

            candidates.push({
                member: {
                    file: entry.file,
                    name: symbol.name,
                    kind: symbol.kind,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    lines: span,
                    exported: symbol.exported,
                    local: symbol.local === true,
                    signature: symbol.signature,
                    hash: symbol.hash ?? hashDeclaration(declaration, symbol.name),
                },
                shingles,
                signature: signatureOf(shingles),
            });
        }
    }

    // Banding: two declarations are worth comparing when any run of ROWS signature entries is
    // identical. Same-name declarations are always compared, because a shared name is the
    // cheapest hint there is and a short body can miss every band.
    const buckets = new Map<string, number[]>();
    let oversizedBuckets = 0;

    for (let index = 0; index < candidates.length; index += 1) {
        const signature = candidates[index]!.signature;

        for (let band = 0; band < BANDS; band += 1) {
            const key = `${band}:${signature.slice(band * ROWS, band * ROWS + ROWS).join(",")}`;
            const bucket = buckets.get(key);

            if (bucket) {
                bucket.push(index);
            } else {
                buckets.set(key, [index]);
            }
        }

        const nameKey = `n:${candidates[index]!.member.kind}:${candidates[index]!.member.name}`;
        const nameBucket = buckets.get(nameKey);

        if (nameBucket) {
            nameBucket.push(index);
        } else {
            buckets.set(nameKey, [index]);
        }
    }

    const seenPairs = new Set<string>();
    const pairs: { left: number; right: number; similarity: number }[] = [];

    for (const bucket of buckets.values()) {
        if (bucket.length < 2) {
            continue;
        }

        if (bucket.length > MAX_BUCKET) {
            oversizedBuckets += 1;
            continue;
        }

        for (let a = 0; a < bucket.length; a += 1) {
            for (let b = a + 1; b < bucket.length; b += 1) {
                const left = Math.min(bucket[a]!, bucket[b]!);
                const right = Math.max(bucket[a]!, bucket[b]!);
                const key = `${left}:${right}`;

                if (seenPairs.has(key)) {
                    continue;
                }

                seenPairs.add(key);
                const similarity = jaccard(candidates[left]!.shingles, candidates[right]!.shingles);

                if (similarity >= threshold) {
                    pairs.push({ left, right, similarity });
                }
            }
        }
    }

    // Greedy clustering against a representative, not transitive union-find. Chaining let a
    // 0.8 pair pull in a member that was 0.5 from everything else in the cluster, and the
    // resulting group could not be described in one sentence.
    pairs.sort((a, b) => b.similarity - a.similarity);

    const clusterOf = new Map<number, number>();
    const clusters: { members: number[]; representative: number; similarity: number }[] = [];

    const similarityTo = (index: number, other: number): number =>
        jaccard(candidates[index]!.shingles, candidates[other]!.shingles);

    for (const pair of pairs) {
        const leftCluster = clusterOf.get(pair.left);
        const rightCluster = clusterOf.get(pair.right);

        if (leftCluster === undefined && rightCluster === undefined) {
            const representative =
                candidates[pair.left]!.member.lines >= candidates[pair.right]!.member.lines ? pair.left : pair.right;

            clusters.push({ members: [pair.left, pair.right], representative, similarity: pair.similarity });
            clusterOf.set(pair.left, clusters.length - 1);
            clusterOf.set(pair.right, clusters.length - 1);
            continue;
        }

        if (leftCluster !== undefined && rightCluster !== undefined) {
            continue;
        }

        const target = leftCluster ?? (rightCluster as number);
        const joining = leftCluster === undefined ? pair.left : pair.right;
        const cluster = clusters[target]!;
        const against = similarityTo(joining, cluster.representative);

        if (against < threshold) {
            continue;
        }

        cluster.members.push(joining);
        cluster.similarity = Math.min(cluster.similarity, against);
        clusterOf.set(joining, target);
    }

    const groups: DuplicateGroup[] = [];
    let patterns = 0;
    let sameFile = 0;

    for (const cluster of clusters) {
        const members = cluster.members
            .map((index) => candidates[index]!.member)
            .sort((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine);

        if (new Set(members.map((member) => member.file)).size === 1) {
            sameFile += 1;

            if (options.includeSameFile !== true) {
                continue;
            }
        }

        const patternReason = patternReasonOf(members, scanRoot);

        if (patternReason !== null) {
            patterns += 1;

            if (options.includePatterns !== true) {
                continue;
            }
        }

        const hashes = new Set(members.map((member) => member.hash));
        const reason: DuplicateReason = hashes.size === 1 ? "identical" : "near";
        const similarity = reason === "identical" ? 1 : Number(cluster.similarity.toFixed(3));
        const lines = Math.max(...members.map((member) => member.lines));
        const wastedLines = members.reduce((total, member) => total + member.lines, 0) - lines;
        const names = [...new Set(members.map((member) => member.name))];
        const base: Omit<DuplicateGroup, "action" | "score"> = {
            id: `${members[0]!.kind}:${names[0]}:${members[0]!.hash}`,
            reason,
            similarity,
            names,
            copies: members.length,
            lines,
            wastedLines,
            members,
            canonical: null,
            pattern: patternReason !== null,
            patternReason,
        };

        const canonical = options.recommend === true ? pickCanonical(members, sharedDirs) : null;
        // A shared name is the clearer defect: the author meant the same thing twice. A
        // renamed copy is real but weaker evidence, so it ranks below an equal-sized one.
        const nameBoost = names.length === 1 ? 1.25 : 1;

        groups.push({
            ...base,
            canonical,
            action: canonical ? actionFor(base, canonical, sharedDirs) : null,
            score: Number((wastedLines * similarity * nameBoost).toFixed(2)),
        });
    }

    groups.sort((left, right) => right.score - left.score || right.copies - left.copies);

    const collisions: NameCollision[] = [];

    if (options.nameCollisions === true) {
        const byName = new Map<string, DuplicateMember[]>();

        for (const candidate of candidates) {
            const key = `${candidate.member.kind}:${candidate.member.name}`;
            const list = byName.get(key);

            if (list) {
                list.push(candidate.member);
            } else {
                byName.set(key, [candidate.member]);
            }
        }

        // Every CLUSTERED member, not only those of emitted groups: a cluster hidden as a pattern or
        // as a same-file group still holds matching code, and listing its members as "same name,
        // different code" said the opposite of the truth.
        const reported = new Set(
            [...clusterOf.keys()].map((index) => {
                const member = candidates[index]?.member;

                return member ? `${member.file}:${member.startLine}` : "";
            })
        );

        for (const [key, members] of byName) {
            if (new Set(members.map((member) => member.file)).size < 2) {
                continue;
            }

            const unreported = members.filter((member) => !reported.has(`${member.file}:${member.startLine}`));

            if (unreported.length < 2) {
                continue;
            }

            collisions.push({
                name: key.split(":")[1] ?? key,
                kind: key.split(":")[0] ?? "",
                members: unreported.sort((left, right) => left.file.localeCompare(right.file)),
            });
        }

        collisions.sort((left, right) => right.members.length - left.members.length);
    }

    return {
        groups,
        collisions,
        scanned: { files: entries.length, symbols, candidates: candidates.length, pairs: seenPairs.size },
        suppressed: { patterns, tooSmall, sameFile, oversizedBuckets },
    };
}
