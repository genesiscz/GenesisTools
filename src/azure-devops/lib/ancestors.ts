export interface WorkItemNode {
    id: number;
    title: string;
    type: string;
    parent?: number;
}

/**
 * Walk a work item's parent chain upwards. Stops at the first item without a parent, at
 * `maxDepth` ancestors above the starting item, or when the chain cycles back on itself.
 * Each work item is fetched exactly once.
 */
export async function walkAncestors({
    fetch,
    id,
    maxDepth = 3,
}: {
    fetch: (id: number) => Promise<WorkItemNode | null>;
    id: number;
    maxDepth?: number;
}): Promise<WorkItemNode[]> {
    const chain: WorkItemNode[] = [];
    const seen = new Set<number>();
    let currentId: number | undefined = id;

    while (currentId !== undefined && !seen.has(currentId) && chain.length <= maxDepth) {
        seen.add(currentId);
        const node = await fetch(currentId);

        if (!node) {
            break;
        }

        chain.push(node);
        currentId = node.parent;
    }

    return chain;
}

/**
 * Walk many parent chains at once, one fetch per tree LEVEL instead of one per ancestor.
 * A month of ~13 work items costs about 4 calls rather than 50. Each work item is requested once.
 */
export async function walkAncestorsBatched({
    fetchMany,
    ids,
    maxDepth = 3,
}: {
    fetchMany: (ids: number[]) => Promise<Map<number, WorkItemNode>>;
    ids: number[];
    maxDepth?: number;
}): Promise<Map<number, WorkItemNode[]>> {
    const known = new Map<number, WorkItemNode>();
    // A work item the API omits never lands in `known`, so without a separate record of what was
    // asked for, an omitted id named as someone else's parent is requested again a level later.
    const attempted = new Set<number>();
    let level = [...new Set(ids)];

    for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
        const wanted = level.filter((id) => !attempted.has(id));

        for (const id of wanted) {
            attempted.add(id);
        }

        if (wanted.length === 0) {
            break;
        }

        const fetched = await fetchMany(wanted);

        for (const [id, node] of fetched) {
            known.set(id, node);
        }

        level = [
            ...new Set(
                wanted
                    .map((id) => known.get(id)?.parent)
                    .filter((parent): parent is number => parent !== undefined && !attempted.has(parent))
            ),
        ];
    }

    const chains = new Map<number, WorkItemNode[]>();

    for (const id of new Set(ids)) {
        const chain: WorkItemNode[] = [];
        const seen = new Set<number>();
        let currentId: number | undefined = id;

        while (currentId !== undefined && !seen.has(currentId) && chain.length <= maxDepth) {
            seen.add(currentId);
            const node = known.get(currentId);

            if (!node) {
                break;
            }

            chain.push(node);
            currentId = node.parent;
        }

        if (chain.length > 0) {
            chains.set(id, chain);
        }
    }

    return chains;
}
