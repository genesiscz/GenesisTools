/** The roles of an actor on one item, derived from rows: claims, posters, the plan tree and the handoffs. */
import type { Item } from "../model/item";
import type { Role } from "../model/vocab";
import type { StoreView } from "../store/view";

export interface RoleAsk {
    /** The actor's own session first; then the sessions of its lead (a T3 parent thread's session). */
    lineage: readonly string[];
    ownerKind: boolean;
    ownerSaid: boolean;
}

function claimedBy(view: StoreView, item: string, session: string): boolean {
    return view.claims({ item, sessionIds: [session], active: true }).length > 0;
}

/** The containers above an item: its parent chain, the handoffs that hold it, the item it was spotted in. */
function ancestors(view: StoreView, item: Item): Item[] {
    const out: Item[] = [];
    const seen = new Set<string>([item.id]);
    const queue: string[] = [item.id];

    while (queue.length > 0) {
        const id = queue.shift() as string;
        const up = [
            ...view
                .refsFrom(id)
                .filter((r) => r.kind === "parent" || r.kind === "spotted-in")
                .map((r) => r.to),
            ...view.memberships(id).map((m) => m.handoff),
        ];

        for (const next of up) {
            if (seen.has(next)) {
                continue;
            }

            seen.add(next);
            const found = view.item(next);

            if (found !== null) {
                out.push(found);
                queue.push(found.id);
            }
        }
    }

    return out;
}

export function rolesOf(view: StoreView, item: Item, ask: RoleAsk): Role[] {
    const roles = new Set<Role>();
    const self = ask.lineage[0];

    if (ask.ownerKind || ask.ownerSaid) {
        roles.add("owner");
    }

    if (self !== undefined) {
        const holders = [
            item,
            ...view
                .memberships(item.id)
                .map((m) => view.item(m.handoff))
                .filter((i): i is Item => i !== null),
        ];

        if (
            claimedBy(view, item.id, self) ||
            item.worker?.sessionId === self ||
            holders.slice(1).some((h) => claimedBy(view, h.id, self))
        ) {
            roles.add("worker");
        }

        if (item.createdBy.sessionId === self) {
            roles.add("poster");
        }
    }

    const leads = ask.lineage;

    if (leads.length > 0) {
        for (const above of ancestors(view, item)) {
            const posted = above.createdBy.sessionId !== null && leads.includes(above.createdBy.sessionId);

            if (posted || leads.some((session) => claimedBy(view, above.id, session))) {
                roles.add("lead");
                break;
            }
        }
    }

    return [...roles];
}
