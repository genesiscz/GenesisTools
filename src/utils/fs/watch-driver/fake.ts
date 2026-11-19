import type { WatchChange, WatchChanges, WatchDriver, WatchedRoot, WatchLoss } from "./types";

interface FakeRoot {
    instance: string;
    generation: number;
    seq: number;
    events: Array<{ seq: number; change: WatchChange }>;
    pendingLoss: WatchLoss | null;
    holds: number;
    releases: Array<() => void>;
    closed: boolean;
}

export type FakeWatchDriver = WatchDriver & {
    emit(root: string, changes: WatchChange[]): void;
    lose(root: string, reason: WatchLoss): void;
    hold(root: string): () => void;
};

/**
 * The test member of `WatchDriver`. `emit` queues changes, `lose` makes the next answer a loss (a `fresh-instance` loss
 * also starts a new instance), and `hold` keeps the next fence open until the returned function runs or `fenceMs` ends.
 */
export function fakeDriver(): FakeWatchDriver {
    const roots = new Map<string, FakeRoot>();

    const stateOf = (root: string): FakeRoot => {
        let state = roots.get(root);

        if (!state) {
            state = {
                instance: "fake-1",
                generation: 1,
                seq: 0,
                events: [],
                pendingLoss: null,
                holds: 0,
                releases: [],
                closed: false,
            };
            roots.set(root, state);
        }

        return state;
    };

    const waitForRelease = (state: FakeRoot, fenceMs: number, signal?: AbortSignal): Promise<boolean> => {
        if (state.holds === 0) {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), fenceMs);
            const done = () => {
                clearTimeout(timer);
                resolve(true);
            };
            state.releases.push(done);
            signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve(false);
            });
        });
    };

    const watchedRoot = (root: string): WatchedRoot => {
        const state = stateOf(root);
        state.closed = false;

        return {
            get instance() {
                return state.instance;
            },
            async changesSince(since, options): Promise<WatchChanges> {
                const started = performance.now();

                if (state.closed) {
                    return { kind: "lost", reason: "closed" };
                }

                const released = await waitForRelease(state, options.fenceMs, options.signal);

                if (!released) {
                    return { kind: "lost", reason: "fence-timeout" };
                }

                if (state.pendingLoss) {
                    const reason = state.pendingLoss;
                    state.pendingLoss = null;
                    return { kind: "lost", reason };
                }

                const clock = `${state.instance}:${state.seq}`;
                const fenceMs = performance.now() - started;

                if (since === null) {
                    return { kind: "changes", clock, changes: [], fenceMs };
                }

                const split = since.lastIndexOf(":");
                const sinceInstance = since.slice(0, split);
                const sinceSeq = Number(since.slice(split + 1));

                if (sinceInstance !== state.instance || !Number.isInteger(sinceSeq)) {
                    return {
                        kind: "lost",
                        reason: "fresh-instance",
                        detail: `clock ${since} is from another instance`,
                    };
                }

                const changes = state.events.filter((event) => event.seq > sinceSeq).map((event) => event.change);
                return { kind: "changes", clock, changes, fenceMs };
            },
            async close() {
                state.closed = true;
            },
        };
    };

    return {
        facts: { outlivesProcess: false, fence: "own-cookie", fencesLinkedWorktrees: true },
        available: async () => ({ ok: true, version: "fake" }),
        open: async (spec) => ({ ok: true, watched: watchedRoot(spec.root) }),
        dispose: async () => {
            roots.clear();
        },
        emit(root, changes) {
            const state = stateOf(root);

            for (const change of changes) {
                state.seq += 1;
                state.events.push({ seq: state.seq, change });
            }
        },
        lose(root, reason) {
            const state = stateOf(root);
            state.pendingLoss = reason;

            if (reason === "fresh-instance") {
                state.generation += 1;
                state.instance = `fake-${state.generation}`;
                state.events = [];
            }
        },
        hold(root) {
            const state = stateOf(root);
            state.holds += 1;
            let released = false;

            return () => {
                if (released) {
                    return;
                }

                released = true;
                state.holds -= 1;

                if (state.holds === 0) {
                    for (const release of state.releases.splice(0)) {
                        release();
                    }
                }
            };
        },
    };
}
