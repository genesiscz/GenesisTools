import type { AdoTaskSimple, WorkItemLinks } from "@app/azure-devops/types";
import { logger } from "@genesiscz/utils/logger";

/** A link target: the item's own fields, with no neighbours of its own. */
export function toAdoTaskSimple(item: WorkItemLinks): AdoTaskSimple {
    return {
        adoID: item.id,
        title: item.title,
        assignedTo: item.assignedTo,
        type: item.type,
        parent: [],
        children: [],
        related: [],
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
    };
}

/**
 * Build the whole neighbourhood of one work item: every ancestor up to the root, every child and
 * every related item.
 *
 * The parent chain is unbounded for the same reason `walkAncestors` is, and the `attempted` set
 * ends a chain that cycles back on itself. The cost is one request for the item, one for its
 * neighbours and its first parent together, and one per further ancestor level.
 */
export async function buildWorkItemTree({
    id,
    fetchMany,
}: {
    id: number;
    fetchMany: (ids: number[]) => Promise<Map<number, WorkItemLinks>>;
}): Promise<AdoTaskSimple | null> {
    const known = new Map<number, WorkItemLinks>();
    const attempted = new Set<number>([id]);
    const rootLevel = await fetchMany([id]);

    for (const [itemId, item] of rootLevel) {
        known.set(itemId, item);
    }

    const root = known.get(id);

    if (!root) {
        return null;
    }

    const ancestors: WorkItemLinks[] = [];
    // Only the ids already ON the chain can end it. `attempted` cannot: it also holds the children
    // and the related items, and Azure DevOps lets one work item be both an ancestor and a related
    // link of the same item. Ending the climb on `attempted` truncated the chain at that ancestor
    // even though it was already in hand, which is the same silent loss the depth cap used to cause.
    const onChain = new Set<number>([id]);
    let climbingTo = root.parentId;
    const firstLevel = [...root.childIds, ...root.relatedIds];

    if (climbingTo !== undefined) {
        firstLevel.push(climbingTo);
    }

    let wanted = [...new Set(firstLevel)].filter((wantedId) => !attempted.has(wantedId));

    while (wanted.length > 0) {
        for (const wantedId of wanted) {
            attempted.add(wantedId);
        }

        const level = await fetchMany(wanted);

        for (const [itemId, item] of level) {
            known.set(itemId, item);
        }

        wanted = [];

        // Climb as far as the items already in hand allow, so an ancestor that arrived as a child
        // or a related item costs no second request.
        while (climbingTo !== undefined && !onChain.has(climbingTo)) {
            const ancestor = known.get(climbingTo);

            if (!ancestor) {
                break;
            }

            onChain.add(climbingTo);
            ancestors.push(ancestor);
            climbingTo = ancestor.parentId;
        }

        if (climbingTo === undefined || onChain.has(climbingTo)) {
            climbingTo = undefined;
            continue;
        }

        if (attempted.has(climbingTo)) {
            logger.debug(`[tree] #${climbingTo} is named as a parent but was not returned; the chain stops here`);
            climbingTo = undefined;
            continue;
        }

        wanted = [climbingTo];
    }

    return {
        ...toAdoTaskSimple(root),
        parent: ancestors.map(toAdoTaskSimple),
        children: resolveLinked(root.childIds, known, "child"),
        related: resolveLinked(root.relatedIds, known, "related"),
    };
}

function resolveLinked(ids: number[], known: Map<number, WorkItemLinks>, kind: string): AdoTaskSimple[] {
    const resolved: AdoTaskSimple[] = [];

    for (const id of ids) {
        const item = known.get(id);

        if (!item) {
            logger.debug(`[tree] ${kind} #${id} was not returned and is left out of the tree`);
            continue;
        }

        resolved.push(toAdoTaskSimple(item));
    }

    return resolved;
}
