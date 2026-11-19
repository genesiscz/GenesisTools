/** The roles of an actor on one item, derived from rows: claims, posters, the plan tree and the handoffs. */
import type { Item } from "../model/item";
import type { Role } from "../model/vocab";
import type { StoreView } from "../store/view";

export interface RoleAsk {
    /** The actor's own session first; then the sessions of its lead (a T3 parent thread's session). */
    lineage: readonly string[];
    ownerKind: boolean;
    sessionId: string | null;
}

export function rolesOf(view: StoreView, item: Item, ask: RoleAsk): Role[] {
    const roles = new Set<Role>();
    const self = ask.sessionId;

    if (ask.ownerKind) {
        roles.add("owner");
    }

    if (self !== null || ask.lineage.length > 0) {
        const evidence = view.roleEvidence(item.id, self, ask.lineage);

        if (evidence.worker) {
            roles.add("worker");
        }

        if (self !== null && item.createdBy.sessionId === self) {
            roles.add("poster");
        }

        if (evidence.lead) {
            roles.add("lead");
        }
    }

    return [...roles];
}
