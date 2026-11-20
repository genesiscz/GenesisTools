/**
 * What a push may make outside, and the outside keys of an item's parent and links. A connector's project can hold
 * personal working lists (the tasks of a handoff) beside the items a team tracks, so a new item is made outside only
 * when the connector's scope takes it. An item that is already paired always syncs.
 */
import type { Database } from "bun:sqlite";
import type { Item, ItemId } from "../model/item";
import { LINK_KINDS, type LinkKind } from "../model/vocab";
import { selectPairings, selectRefsFrom } from "../store/rows";
import type { StoreView } from "../store/view";
import type { PushIntent } from "./types";

export interface ConnectorScope {
    handoffTasks: boolean;
    under: readonly string[];
    tags: readonly string[];
}

export type OutOfScope = "handoff-task" | "not-under";

/** Parent chains are short; the bound only stops a cycle written by hand. */
const MAX_DEPTH = 64;

/** Null when the scope takes the item; else why it does not. */
export function outOfScope(view: StoreView, item: Item, scope: ConnectorScope): OutOfScope | null {
    if (!scope.handoffTasks && view.memberships(item.id).length > 0) {
        return "handoff-task";
    }

    if (scope.under.length === 0 && scope.tags.length === 0) {
        return null;
    }

    if (item.tags.some((tag) => scope.tags.includes(tag))) {
        return null;
    }

    let at: ItemId | null = item.id;

    for (let depth = 0; at !== null && depth < MAX_DEPTH; depth++) {
        if (scope.under.includes(at)) {
            return null;
        }

        at = view.parentOf(at);
    }

    return "not-under";
}

const LINKS = new Set<string>(LINK_KINDS);

function isLinkKind(kind: string): kind is LinkKind {
    return LINKS.has(kind);
}

/** The items whose outside keys this item's push names: its parent and the targets of its own links. */
export function referencedItems(db: Database, item: ItemId): ItemId[] {
    return selectRefsFrom(db, item)
        .filter((ref) => ref.kind === "parent" || isLinkKind(ref.kind))
        .map((ref) => ref.to);
}

function keyOf(db: Database, item: ItemId, connector: string): string | undefined {
    const key = selectPairings(db, { item, connector })[0]?.remoteKey;
    return key !== undefined && key !== "" ? key : undefined;
}

/** The parent's and the link targets' outside keys on one connector, read when the push is about to run. */
export function outsideRefs(db: Database, item: ItemId, connector: string): Pick<PushIntent, "parentKey" | "links"> {
    let parentKey: string | undefined;
    const links: { kind: LinkKind; remoteKey: string }[] = [];

    for (const ref of selectRefsFrom(db, item)) {
        const key = keyOf(db, ref.to, connector);

        if (key === undefined) {
            continue;
        }

        if (ref.kind === "parent") {
            parentKey = key;
        } else if (isLinkKind(ref.kind)) {
            links.push({ kind: ref.kind, remoteKey: key });
        }
    }

    return { ...(parentKey !== undefined ? { parentKey } : {}), links };
}
