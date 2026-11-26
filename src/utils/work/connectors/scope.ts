/**
 * What a push may make outside, and the outside keys of an item's parent and links. A connector's project can hold
 * personal working lists (the tasks of a handoff) beside the items a team tracks, so a new item is made outside only
 * when the connector's scope takes it. An item that is already paired always syncs.
 */
import type { Database } from "bun:sqlite";
import type { Item, ItemId } from "../model/item";
import { LINK_KINDS, type LinkKind } from "../model/vocab";
import { selectRefsFrom } from "../store/rows";
import type { StoreView } from "../store/view";
import type { PushIntent } from "./types";

export interface ConnectorScope {
    handoffTasks: boolean;
    under: readonly string[];
    tags: readonly string[];
}

export type OutOfScope = "handoff-task" | "not-under";

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

    const seen = new Set<ItemId>();
    while (at !== null && !seen.has(at)) {
        seen.add(at);
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

/** The parent's and the link targets' outside keys on one connector, read when the push is about to run. */
export function outsideRefs(
    db: Database,
    item: ItemId,
    connector: string,
    references = selectRefsFrom(db, item)
): Pick<PushIntent, "parentKey" | "links"> {
    const targets = references.filter((ref) => ref.kind === "parent" || isLinkKind(ref.kind)).map((ref) => ref.to);
    const keys = new Map(
        targets.length
            ? db
                  .query<{ item: ItemId; remote_key: string }, string[]>(
                      `SELECT item, remote_key FROM pairings WHERE connector = ? AND item IN (${targets.map(() => "?").join(",")}) AND remote_key <> ''`
                  )
                  .all(connector, ...targets)
                  .map((row) => [row.item, row.remote_key])
            : []
    );
    let parentKey: string | undefined;
    const links: { kind: LinkKind; remoteKey: string }[] = [];

    for (const ref of references) {
        const key = keys.get(ref.to);

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
