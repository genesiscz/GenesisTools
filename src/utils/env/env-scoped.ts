import { AsyncLocalStorage } from "node:async_hooks";
import type { EnvKey } from "@genesiscz/utils/env/env-core";

/** One key held by one or more running scopes that all set the same value. */
interface KeyHold {
    /** The value the holders asked for; a nested override never changes it. */
    value: string | undefined;
    /** The value before the first of these scopes started; put back when the last one ends. */
    previous: string | undefined;
    holders: number;
    /** The top-level scopes (flow roots) holding this key, with how many of their scopes hold it. */
    owners: Map<symbol, number>;
    /** The running nested overrides of this key, innermost last; while any runs, nobody may join. */
    nestedOverrides: symbol[];
    /** Settles at the next change of this hold, so a waiting scope checks again. */
    changed: Promise<void>;
    notify: () => void;
}

function newHold(value: string | undefined, previous: string | undefined): KeyHold {
    const hold: KeyHold = {
        value,
        previous,
        holders: 1,
        owners: new Map(),
        nestedOverrides: [],
        changed: Promise.resolve(),
        notify: () => undefined,
    };
    rearm(hold);

    return hold;
}

/** Wakes every scope waiting on `hold` and arms a fresh signal for the next change. */
function rearm(hold: KeyHold): void {
    const wake = hold.notify;
    hold.changed = new Promise<void>((resolve) => {
        hold.notify = resolve;
    });
    wake();
}

const holds = new Map<string, KeyHold>();

/** The holds each top-level scope is waiting on right now, to find a wait cycle before it forms. */
const waiting = new Map<symbol, Set<KeyHold>>();

/** A wait has a deadline (CLAUDE.md): past it the scope throws instead of hanging. */
const WAIT_DEADLINE_MS = 10 * 60_000;

interface Flow {
    /** The top-level scope this async flow runs under; every scope nested in it shares the root. */
    root: symbol;
    /**
     * The keys the flow already holds, so a nested scope on one of them runs at once, each with the
     * token of the innermost nested override this flow runs inside (undefined for none).
     */
    keys: ReadonlyMap<string, symbol | undefined>;
}

const heldKeys = new AsyncLocalStorage<Flow>();

function addOwner(hold: KeyHold, root: symbol): void {
    hold.owners.set(root, (hold.owners.get(root) ?? 0) + 1);
}

function removeOwner(hold: KeyHold, root: symbol): void {
    const count = (hold.owners.get(root) ?? 1) - 1;

    if (count > 0) {
        hold.owners.set(root, count);
    } else {
        hold.owners.delete(root);
    }
}

/** Whether `root` waiting on `hold` closes a cycle: some owner of `hold` waits, directly or not, on `root`. */
function closesWaitCycle(hold: KeyHold, root: symbol): boolean {
    const seen = new Set<symbol>();
    const queue = [...hold.owners.keys()];

    while (queue.length > 0) {
        const owner = queue.shift() as symbol;

        if (owner === root) {
            return true;
        }

        if (seen.has(owner)) {
            continue;
        }

        seen.add(owner);

        for (const awaited of waiting.get(owner) ?? []) {
            queue.push(...awaited.owners.keys());
        }
    }

    return false;
}

async function waitForChange(hold: KeyHold, root: symbol, key: string): Promise<void> {
    if (closesWaitCycle(hold, root)) {
        throw new Error(
            `${key}: waiting for this scope would deadlock, since a scope that holds ${key} is itself waiting on a key this scope's flow holds`
        );
    }

    const set = waiting.get(root) ?? new Set<KeyHold>();
    set.add(hold);
    waiting.set(root, set);
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([
            hold.changed,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `${key}: waited ${WAIT_DEADLINE_MS / 60_000} minutes for a conflicting scope to end`
                            )
                        ),
                    WAIT_DEADLINE_MS
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
        set.delete(hold);

        if (set.size === 0) {
            waiting.delete(root);
        }
    }
}

/**
 * Runs `fn` with `overrides` applied to process.env, then puts back ONLY those keys. The test
 * helper `withEnvOverrides` restores the whole environment, which in production would also undo
 * a variable that something else in the process set while `fn` ran.
 *
 * Overlapping scopes are coordinated per key. Scopes that set a key to the SAME value run
 * together, and the value from before the first one comes back when the last one ends
 * (concurrent artifact builds all set NODE_ENV=production). A scope that sets a key to a
 * DIFFERENT value waits until the running ones finish: two scopes that each saved and restored
 * on their own let the first to finish pull the value out from under the second, and the last to
 * finish put back the other one's override instead of the original. Scopes on other keys never
 * wait, and a scope nested inside another one on the same key runs inside it.
 *
 * A nested scope may change a held key only while its own flow is the key's sole holder: with a
 * sibling scope sharing the key it throws, since the sibling would see a value it never asked
 * for. While a nested scope changes the key, no new scope may join the hold, whatever value it
 * wants: one that joined would see the value change under it when the nested scope ends. Every
 * change to a hold (a nested override ending, the last holder leaving) wakes the scopes waiting
 * on it, so they check again instead of waiting for the whole outer scope. Two nested scopes
 * running side by side in one flow cannot both change a key: the second throws, since whichever
 * ended last would put back the other's value. A nested scope inside a nested scope is fine.
 *
 * A wait that would close a cycle (this flow holds A and waits for B, while the flow holding B
 * waits for A) throws at once instead of hanging, and no wait outlasts WAIT_DEADLINE_MS.
 */
export async function withScopedEnv<T>(
    overrides: Record<EnvKey, string | undefined>,
    fn: () => T | Promise<T>
): Promise<T> {
    const flowStore = heldKeys.getStore();
    const outer = flowStore?.keys;
    const root = flowStore?.root ?? Symbol("withScopedEnv");
    const keys = Object.keys(overrides);
    const nested = keys.filter((key) => outer?.has(key));
    const shared = keys.filter((key) => !outer?.has(key));

    for (let conflict = conflictingHold(shared, overrides); conflict; conflict = conflictingHold(shared, overrides)) {
        await waitForChange(conflict.hold, root, conflict.key);
    }

    for (const key of nested) {
        const hold = holds.get(key);

        if (hold && hold.holders > 1 && hold.value !== overrides[key]) {
            throw new Error(
                `${key} is shared by ${hold.holders} running scopes, so a nested scope cannot change it from ${String(hold.value)} to ${String(overrides[key])}`
            );
        }

        const innermost = hold?.nestedOverrides.at(-1);

        if (innermost !== undefined && innermost !== outer?.get(key)) {
            throw new Error(
                `${key} is already changed by a nested scope running beside this one, so this nested scope cannot change it to ${String(overrides[key])}`
            );
        }
    }

    for (const key of shared) {
        const hold = holds.get(key);

        if (hold) {
            hold.holders++;
            addOwner(hold, root);
            continue;
        }

        const created = newHold(overrides[key], process.env[key]);
        addOwner(created, root);
        holds.set(key, created);
        setEnv(key, overrides[key]);
    }

    const nestedPrevious = new Map(nested.map((key) => [key, process.env[key]]));
    const flow = new Map(outer);
    const overridden: Array<{ hold: KeyHold; token: symbol }> = [];

    for (const key of nested) {
        setEnv(key, overrides[key]);
        const hold = holds.get(key);

        if (hold) {
            const token = Symbol(key);
            hold.nestedOverrides.push(token);
            overridden.push({ hold, token });
            flow.set(key, token);
        }
    }

    for (const key of shared) {
        flow.set(key, undefined);
    }

    try {
        return await heldKeys.run({ root, keys: flow }, fn);
    } finally {
        for (const [key, value] of nestedPrevious) {
            setEnv(key, value);
        }

        for (const { hold, token } of overridden) {
            hold.nestedOverrides.splice(hold.nestedOverrides.indexOf(token), 1);
            rearm(hold);
        }

        for (const key of shared) {
            const hold = holds.get(key);

            if (!hold) {
                continue;
            }

            hold.holders--;
            removeOwner(hold, root);

            if (hold.holders === 0) {
                setEnv(key, hold.previous);
                holds.delete(key);
                rearm(hold);
            }
        }
    }
}

/** A running hold on one of `keys` that a scope wanting `overrides` may not join yet, if any. */
function conflictingHold(
    keys: string[],
    overrides: Record<EnvKey, string | undefined>
): { hold: KeyHold; key: string } | undefined {
    for (const key of keys) {
        const hold = holds.get(key);

        if (hold && (hold.nestedOverrides.length > 0 || hold.value !== overrides[key])) {
            return { hold, key };
        }
    }

    return undefined;
}

function setEnv(key: EnvKey, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}
