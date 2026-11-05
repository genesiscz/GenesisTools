import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const scope = new AsyncLocalStorage<{ ids: string[]; index: number }>();

/** Creation IDs stay stable when the same operation is replayed after an external save. */
export function withItemIds<T>(ids: string[], work: () => T): T {
    return scope.run({ ids, index: 0 }, work);
}

export function recordingItemId(prefix: string): string {
    const current = scope.getStore();
    if (!current) {
        return `${prefix}${randomUUID().slice(0, 8)}`;
    }
    const index = current.index++;
    const id = current.ids[index] ?? `${prefix}${randomUUID().slice(0, 8)}`;
    current.ids[index] = id;
    return id;
}
