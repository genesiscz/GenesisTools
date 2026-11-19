/**
 * The merged verdict, pure: every function here takes parsed git output and
 * returns a decision, so the ladder is pinned by fixtures without a repo.
 *
 *   EMPTY     tip == base tip                             a branch with nothing on it
 *   MERGED    ancestor   merge-base --is-ancestor         plain merge / fast-forward (ahead == 0)
 *   MERGED    cherry     git cherry has no "+"            rebased or cherry-picked (patch-ids match)
 *   MERGED    content    blob containment                 squashed, RECOMPOSED, or a snapshot
 *   STALE     superseded every unlanded file was rewritten on the base after the fork
 *   UNMERGED  none       files whose branch blob never existed on the base
 *
 * `how` is reported so the reader learns why git's own tests would have lied.
 * An ancestor of the base always has ahead == 0, so the ancestor tier IS the
 * ahead == 0 case; EMPTY is reserved for a branch sitting exactly on the base.
 */

import type { NameStatusEntry, RawChange } from "@genesiscz/utils/git";

export type Verdict = "MERGED" | "EMPTY" | "STALE" | "UNMERGED";
export type How = "ancestor" | "cherry" | "content" | "superseded" | "none" | "-";

export interface QuickFacts {
    ahead: number;
    /** The branch tip is the base tip itself. */
    atBase: boolean;
    cherryPlus: number;
}

export interface VerdictResult {
    verdict: Verdict;
    how: How;
    unmerged: NameStatusEntry[];
}

/**
 * Did the base rewrite this path itself after the fork? Then the branch holds an
 * OLDER draft of a file that moved on without it, which is a different thing from
 * work nobody ever landed. A pre-review snapshot of a squash-merged PR lands here:
 * its blobs are nowhere in the base, yet every one of its files was rewritten
 * upstream. Reporting that as plain UNMERGED made ten such branches unanswerable
 * without hand-diffing each file.
 */
function isSupersededPath(path: string, historicBlobs: Map<string, Set<string>>): boolean {
    return historicBlobs.has(path);
}

/** The cheap tiers. Null means the content tier has to decide. */
export function quickVerdict(facts: QuickFacts): VerdictResult | null {
    if (facts.atBase) {
        return { verdict: "EMPTY", how: "-", unmerged: [] };
    }

    if (facts.ahead === 0) {
        return { verdict: "MERGED", how: "ancestor", unmerged: [] };
    }

    if (facts.cherryPlus === 0) {
        return { verdict: "MERGED", how: "cherry", unmerged: [] };
    }

    return null;
}

export interface ContentEvidence {
    /** Every path the branch changed since its merge-base with the base. */
    changes: NameStatusEntry[];
    /** path → blob of the branch tip. */
    branchBlobs: Map<string, string>;
    /** path → blob of the base tip. */
    baseBlobs: Map<string, string>;
    /** path → every blob the base's history gave that path between the merge-base and its tip. */
    historicBlobs: Map<string, Set<string>>;
}

/** Group `log --raw` changes into path → every blob that path was given. */
export function historicBlobsOf(changes: RawChange[]): Map<string, Set<string>> {
    const seen = new Map<string, Set<string>>();

    for (const change of changes) {
        let set = seen.get(change.path);

        if (!set) {
            set = new Set();
            seen.set(change.path, set);
        }

        set.add(change.newSha);
    }

    return seen;
}

/**
 * Blob containment. Squash, rebase and recompose all preserve the final tree
 * of the work, so the branch's last version of every file it touched exists
 * somewhere in the base's history after the fork even when no commit and no
 * patch-id survives. A deleted path is merged when the base no longer has it.
 * The base's own newer versions are irrelevant: a branch far behind is not
 * penalised, only the files whose branch version never landed are listed.
 */
export function contentVerdict(evidence: ContentEvidence): VerdictResult {
    const unmerged: NameStatusEntry[] = [];

    for (const change of evidence.changes) {
        if (change.status === "D") {
            if (evidence.baseBlobs.has(change.path)) {
                unmerged.push(change);
            }

            continue;
        }

        const blob = evidence.branchBlobs.get(change.path);

        if (blob !== undefined && evidence.baseBlobs.get(change.path) === blob) {
            continue;
        }

        if (blob === undefined || !evidence.historicBlobs.get(change.path)?.has(blob)) {
            unmerged.push(change);
        }
    }

    if (unmerged.length === 0) {
        return { verdict: "MERGED", how: "content", unmerged };
    }

    if (unmerged.every((change) => isSupersededPath(change.path, evidence.historicBlobs))) {
        return { verdict: "STALE", how: "superseded", unmerged };
    }

    return { verdict: "UNMERGED", how: "none", unmerged };
}
