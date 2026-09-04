/**
 * Child detection and ordering, pure. A branch is a child of the parent when
 * its merge-base with the parent holds commits the target lacks: it carries
 * parent-only work and would be orphaned when the parent moves. The old
 * tip-ancestor rule (`findPotentialChildren`) missed every child forked from
 * an older parent commit.
 */

export interface BranchFacts {
    name: string;
    /** Commits on merge-base(branch, parent) that the target lacks. */
    depthViaParent: number;
    /**
     * Same measure via merge-base(branch, other candidate), by candidate
     * name. A candidate that CONTAINS this branch (the merge-base is this
     * branch's own tip) is left out: it is a descendant, never a parent.
     */
    depthVia: Record<string, number>;
}

export interface DetectedChild {
    name: string;
    /** The parent, or the sibling whose history the child is stacked on. */
    directParent: string;
}

/**
 * Children are the branches with parent-only commits. A child's direct
 * parent is whichever other child shares strictly more parent-side history
 * with it than the parent itself does (a child of a child); ties and
 * everything else go to the parent.
 */
export function detectChildren(parent: string, facts: BranchFacts[]): DetectedChild[] {
    const children = facts.filter((f) => f.name !== parent && f.depthViaParent > 0);
    const names = new Set(children.map((c) => c.name));

    return children.map((child) => {
        let directParent = parent;
        let best = child.depthViaParent;

        for (const [other, depth] of Object.entries(child.depthVia)) {
            if (names.has(other) && other !== child.name && depth > best) {
                best = depth;
                directParent = other;
            }
        }

        return { name: child.name, directParent };
    });
}

/** Parents before children; siblings keep their input order. Throws on a cycle. */
export function orderChildren(parent: string, children: DetectedChild[]): DetectedChild[] {
    const ordered: DetectedChild[] = [];
    const done = new Set<string>([parent]);
    let remaining = [...children];

    while (remaining.length > 0) {
        const ready = remaining.filter((c) => done.has(c.directParent));

        if (ready.length === 0) {
            throw new Error(`cascade: cannot order children, cycle among ${remaining.map((c) => c.name).join(", ")}`);
        }

        for (const c of ready) {
            ordered.push(c);
            done.add(c.name);
        }

        remaining = remaining.filter((c) => !done.has(c.name));
    }

    return ordered;
}
