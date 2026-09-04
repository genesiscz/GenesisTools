/**
 * Pure helpers behind the reorderable sidebar and the reorderable section
 * blocks. Both persist an ordered list and reconcile it against the current
 * defaults, so a route or block added later never vanishes from a stored order.
 */

export interface BlockEntry {
    id: string;
    visible: boolean;
}

/** Keep the stored order for known ids, drop unknown ids, append new ids in default order. */
export function reconcileOrder(stored: readonly string[] | null, defaults: readonly string[]): string[] {
    const known = new Set(defaults);
    const kept = (stored ?? []).filter((id, index, all) => known.has(id) && all.indexOf(id) === index);
    const seen = new Set(kept);
    const appended = defaults.filter((id) => !seen.has(id));

    return [...kept, ...appended];
}

export function reconcileLayout(stored: readonly BlockEntry[] | null, defaults: readonly string[]): BlockEntry[] {
    const storedIds = stored ? stored.map((b) => b.id) : null;
    const order = reconcileOrder(storedIds, defaults);
    const visibility = new Map((stored ?? []).map((b) => [b.id, b.visible] as const));

    return order.map((id) => ({ id, visible: visibility.get(id) ?? true }));
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
    if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) {
        return [...list];
    }

    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);

    return next;
}

export function moveById<T extends { id: string }>(list: readonly T[], id: string, direction: -1 | 1): T[] {
    const from = list.findIndex((item) => item.id === id);

    if (from === -1) {
        return [...list];
    }

    return moveItem(list, from, from + direction);
}

export function setVisible(list: readonly BlockEntry[], id: string, visible: boolean): BlockEntry[] {
    return list.map((entry) => (entry.id === id ? { ...entry, visible } : entry));
}

export function parseBlockEntries(raw: unknown): BlockEntry[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }

    const entries: BlockEntry[] = [];

    for (const item of raw) {
        if (typeof item !== "object" || item === null) {
            return null;
        }

        const record = item as Record<string, unknown>;

        if (typeof record.id !== "string" || typeof record.visible !== "boolean") {
            return null;
        }

        entries.push({ id: record.id, visible: record.visible });
    }

    return entries;
}
