import { describe, expect, test } from "bun:test";
import { type CmuxHealth, CmuxUnresponsiveError } from "./lib/health";
import {
    type CmuxTreeBackoff,
    TREE_BACKOFF_FIRST_MS,
    TREE_BACKOFF_MAX_MS,
    type TreeBackoffStore,
    treeBackoffDelayMs,
} from "./lib/tree-backoff";
import { CMUX_TREE_TIMEOUT_MS, readCmuxTree } from "./tree-read";

/** A `cmux --json --id-format both tree --all` answer, trimmed to the fields the readers use. */
const FIXTURE = {
    caller: { surface_ref: "surface:2", surface_id: "S-2" },
    windows: [
        {
            id: "W-1",
            ref: "window:1",
            workspaces: [
                {
                    id: "WS-1",
                    ref: "workspace:1",
                    title: "app",
                    panes: [
                        {
                            id: "P-1",
                            ref: "pane:1",
                            surfaces: [
                                {
                                    id: "S-1",
                                    ref: "surface:1",
                                    type: "terminal",
                                    title: "app - claude",
                                    tty: "ttys001",
                                    index_in_pane: 0,
                                    index: 4,
                                    selected_in_pane: true,
                                    url: null,
                                    pane_ref: "pane:1",
                                },
                                { id: "S-2", ref: "surface:2", type: "browser", url: "https://example.com", index: 1 },
                            ],
                        },
                        { id: "P-2", ref: "pane:2" },
                    ],
                },
            ],
        },
    ],
};

function memoryStore(): TreeBackoffStore & { record: CmuxTreeBackoff | null } {
    return {
        record: null,
        read() {
            return this.record;
        },
        write(record) {
            this.record = record;
        },
    };
}

function unresponsive(state: CmuxHealth["state"], appPid?: number): CmuxUnresponsiveError {
    return new CmuxUnresponsiveError("cmux tree", {
        state,
        appPid,
        probes: { ping: { ok: false, ms: 1500 }, identify: { ok: false, ms: 0 } },
    });
}

const failing = async (): Promise<unknown> => {
    throw new Error("cmux tree --all failed (1): timed out");
};

describe("readCmuxTree", () => {
    test("asks once with the UUID argv and the bound, and parses ids, refs, ttys and pane fallbacks", async () => {
        const calls: Array<{ args: string[]; timeoutMs: number }> = [];
        const read = await readCmuxTree({
            run: async (args, opts) => {
                calls.push({ args, timeoutMs: opts.timeoutMs });
                return FIXTURE;
            },
        });

        expect(calls).toEqual([{ args: ["--id-format", "both", "tree", "--all"], timeoutMs: CMUX_TREE_TIMEOUT_MS }]);
        expect(read.ok).toBe(true);

        if (!read.ok) {
            return;
        }

        expect(read.tree.caller).toEqual({ surfaceId: "S-2", surfaceRef: "surface:2" });
        const [first, second] = read.tree.windows[0].workspaces[0].panes;
        expect(first.surfaces).toEqual([
            {
                id: "S-1",
                ref: "surface:1",
                tty: "ttys001",
                type: "terminal",
                title: "app - claude",
                index: 0,
                selected: true,
                url: null,
                paneRef: "pane:1",
            },
            {
                id: "S-2",
                ref: "surface:2",
                tty: null,
                type: "browser",
                title: null,
                index: 1,
                selected: null,
                url: "https://example.com",
                paneRef: null,
            },
        ]);
        // A pane the tree lists without surfaces says so, so the snapshot asks cmux for that pane itself.
        expect(second.surfaces).toBeNull();
    });

    test("an answer that is not an object is a failed read, never an empty tree", async () => {
        expect(await readCmuxTree({ run: async () => "nope" })).toEqual({
            ok: false,
            reason: "failed",
            error: "cmux tree answered no object",
        });
    });

    test("a runner that never answers is a timeout at the bound, and the probe's diagnosis is the error", async () => {
        const started = performance.now();
        const read = await readCmuxTree({
            run: () => new Promise<unknown>(() => {}),
            timeoutMs: 30,
            probe: async () => {
                throw unresponsive("socket-dead", 42);
            },
        });

        expect(performance.now() - started).toBeLessThan(1_000);
        expect(read).toMatchObject({ ok: false, reason: "timeout" });
        expect(read.ok ? "" : read.error).toContain("its socket does not answer");
    });

    test("a probe that finds cmux healthy leaves the command's own error standing", async () => {
        const read = await readCmuxTree({ run: failing, probe: async () => undefined });

        expect(read).toEqual({ ok: false, reason: "failed", error: "cmux tree --all failed (1): timed out" });
    });

    test("callers in flight at the same moment share one cmux call", async () => {
        let calls = 0;
        let answer: (value: unknown) => void = () => {};
        const run = () => {
            calls++;
            return new Promise<unknown>((resolve) => {
                answer = resolve;
            });
        };
        const both = Promise.all([readCmuxTree({ run }), readCmuxTree({ run })]);
        answer(FIXTURE);
        const [a, b] = await both;

        expect(calls).toBe(1);
        expect(a).toBe(b);
        await readCmuxTree({ run });
        expect(calls).toBe(2);
    });
});

describe("readCmuxTree backoff after cmux does not answer", () => {
    test("a dead socket is asked once per doubling delay, and a success clears the memory", async () => {
        const backoff = memoryStore();
        let clock = 1_000_000;
        let calls = 0;
        let healthy = false;
        const options = {
            backoff,
            appPid: () => 42,
            now: () => clock,
            probe: async () => {
                if (!healthy) {
                    throw unresponsive("socket-dead", 42);
                }
            },
            run: async () => {
                calls++;

                if (!healthy) {
                    throw new Error("cmux tree --all timed out");
                }

                return FIXTURE;
            },
        };

        expect((await readCmuxTree(options)).ok).toBe(false);
        expect(calls).toBe(1);
        expect(backoff.record?.until).toBe(clock + TREE_BACKOFF_FIRST_MS);

        clock += TREE_BACKOFF_FIRST_MS - 1;
        const skipped = await readCmuxTree(options);
        expect(calls).toBe(1);
        expect(skipped).toMatchObject({ ok: false, reason: "backoff" });
        expect(skipped.ok ? "" : skipped.error).toContain("its socket does not answer");
        expect(skipped.ok ? "" : skipped.error).toContain("the next try is after");

        clock += 1;
        await readCmuxTree(options);
        expect(calls).toBe(2);
        expect(backoff.record?.failures).toBe(2);
        expect(backoff.record?.until).toBe(clock + 2 * TREE_BACKOFF_FIRST_MS);

        clock = backoff.record?.until ?? clock;
        healthy = true;
        expect((await readCmuxTree(options)).ok).toBe(true);
        expect(calls).toBe(3);
        expect(backoff.record).toBeNull();
    });

    test("a restarted cmux (another pid) is asked at once", async () => {
        const backoff = memoryStore();
        backoff.record = { failures: 3, until: Date.now() + 60_000, state: "socket-dead", appPid: 42, error: "dead" };
        let calls = 0;
        const read = await readCmuxTree({
            backoff,
            appPid: () => 43,
            run: async () => {
                calls++;
                return FIXTURE;
            },
        });

        expect(calls).toBe(1);
        expect(read.ok).toBe(true);
        expect(backoff.record).toBeNull();
    });

    test("a restarted cmux that fails starts at the shortest backoff", async () => {
        const backoff = memoryStore();
        backoff.record = { failures: 5, until: Date.now() + 300_000, state: "socket-dead", appPid: 42, error: "dead" };
        await readCmuxTree({
            backoff,
            appPid: () => 43,
            run: failing,
            probe: async () => {
                throw unresponsive("socket-dead", 43);
            },
        });

        expect(backoff.record?.failures).toBe(1);
        expect(backoff.record?.appPid).toBe(43);
    });

    test("a failure that is not cmux hanging leaves no memory", async () => {
        const backoff = memoryStore();
        await readCmuxTree({
            backoff,
            run: failing,
            probe: async () => {
                throw unresponsive("not-running");
            },
        });

        expect(backoff.record).toBeNull();
    });

    test("the delay doubles from 20 s and stops at 5 min", () => {
        expect([1, 2, 3, 4, 5, 6, 10].map(treeBackoffDelayMs)).toEqual([
            20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
        ]);
        expect(TREE_BACKOFF_MAX_MS).toBe(300_000);
    });
});
