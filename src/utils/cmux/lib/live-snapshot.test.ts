import { describe, expect, test } from "bun:test";
import { fetchCmuxLiveSnapshot } from "./live-snapshot";

describe("fetchCmuxLiveSnapshot", () => {
    /**
     * Concurrency is measured as OVERLAP, not as a stopwatch. The wall-clock form
     * asserted `elapsed < 110` against three 50ms calls, so the budget sat between
     * the parallel case (~50ms) and the sequential one (~150ms) — and a loaded CI
     * runner took 134ms on a genuinely parallel run, landing inside the sequential
     * band. Peak in-flight is the property the test is actually about, and a
     * sequential implementation reports 1 however fast the machine is.
     */
    test("fetches all workspaces in parallel, not sequentially", async () => {
        let inFlight = 0;
        let peakInFlight = 0;

        const runJson = async <T>(args: string[]): Promise<T> => {
            if (args[0] === "list-workspaces") {
                return { workspaces: [{ ref: "ws-0" }, { ref: "ws-1" }, { ref: "ws-2" }] } as T;
            }

            if (args[0] === "list-panes") {
                inFlight++;
                peakInFlight = Math.max(peakInFlight, inFlight);
                await new Promise((r) => setTimeout(r, 20));
                inFlight--;
                return { panes: [] } as T;
            }

            return {} as T;
        };

        const run = async () => ({ code: 0, stdout: "", stderr: "" });
        const snapshot = await fetchCmuxLiveSnapshot({ runJson, run });

        expect(snapshot.available).toBe(true);
        expect(peakInFlight).toBe(3);
    });

    test("allWindows lists every window and keeps each workspace with its own", async () => {
        // The default path issues one bare `list-workspaces`. This branch fans out
        // one `list-workspaces --window <id>` per listed window, and the window_ref
        // each answer carries is what ties a workspace back to its window.
        const calls: string[][] = [];

        const runJson = async <T>(args: string[]): Promise<T> => {
            calls.push(args);

            if (args[0] === "list-windows") {
                return [
                    { id: "win-a", index: 0, key: true, workspace_count: 1 },
                    { id: "win-b", index: 1, key: false, workspace_count: 1 },
                ] as T;
            }

            if (args[0] === "list-workspaces") {
                const window = args[args.indexOf("--window") + 1];

                return window === "win-a"
                    ? ({ window_ref: "window:1", workspaces: [{ ref: "ws-a" }] } as T)
                    : ({ window_ref: "window:2", workspaces: [{ ref: "ws-b" }] } as T);
            }

            if (args[0] === "list-panes") {
                return { panes: [] } as T;
            }

            return {} as T;
        };

        const snapshot = await fetchCmuxLiveSnapshot({
            runJson,
            run: async () => ({ code: 0, stdout: "", stderr: "" }),
            allWindows: true,
        });

        expect(calls.filter((args) => args[0] === "list-windows")).toHaveLength(1);
        expect(calls.filter((args) => args[0] === "list-workspaces")).toEqual([
            ["list-workspaces", "--window", "win-a"],
            ["list-workspaces", "--window", "win-b"],
        ]);
        expect(snapshot.windows?.map((window) => [window.id, window.ref, window.key])).toEqual([
            ["win-a", "window:1", true],
            ["win-b", "window:2", false],
        ]);
        expect(snapshot.workspaces.map((ws) => [ws.id, ws.windowRef])).toEqual([
            ["ws-a", "window:1"],
            ["ws-b", "window:2"],
        ]);
    });

    test("lists pane surfaces in parallel across panes in one workspace", async () => {
        let inflight = 0;
        let maxInflight = 0;

        const runJson = async <T>(args: string[]): Promise<T> => {
            if (args[0] === "list-workspaces") {
                return { workspaces: [{ ref: "ws-0" }] } as T;
            }

            if (args[0] === "list-panes") {
                return {
                    window_ref: "window:9",
                    panes: [{ ref: "pane-0" }, { ref: "pane-1" }, { ref: "pane-2" }],
                } as T;
            }

            if (args[0] === "list-pane-surfaces") {
                inflight += 1;
                maxInflight = Math.max(maxInflight, inflight);
                await new Promise((r) => setTimeout(r, 40));
                inflight -= 1;
                return { surfaces: [] } as T;
            }

            return {} as T;
        };

        const snapshot = await fetchCmuxLiveSnapshot({
            runJson,
            run: async () => ({ code: 0, stdout: "", stderr: "" }),
        });

        expect(snapshot.panes).toHaveLength(3);
        expect(maxInflight).toBe(3);
        expect(snapshot.panes.every((pane) => pane.windowRef === "window:9")).toBe(true);
    });

    test("captures surface previews in parallel across panes", async () => {
        let inflight = 0;
        let maxInflight = 0;

        const runJson = async <T>(args: string[]): Promise<T> => {
            if (args[0] === "list-workspaces") {
                return { workspaces: [{ ref: "ws-0" }] } as T;
            }

            if (args[0] === "list-panes") {
                return { panes: [{ ref: "pane-0" }, { ref: "pane-1" }, { ref: "pane-2" }] } as T;
            }

            if (args[0] === "list-pane-surfaces") {
                const pane = args[args.indexOf("--pane") + 1];
                return { surfaces: [{ ref: `surface-${pane}`, selected_in_pane: true }] } as T;
            }

            return {} as T;
        };

        const run = async (args: string[]) => {
            if (args[0] === "capture-pane") {
                inflight += 1;
                maxInflight = Math.max(maxInflight, inflight);
                await new Promise((r) => setTimeout(r, 40));
                inflight -= 1;
                return { code: 0, stdout: "prompt", stderr: "" };
            }

            return { code: 0, stdout: "", stderr: "" };
        };

        const snapshot = await fetchCmuxLiveSnapshot({ runJson, run });

        expect(snapshot.panes).toHaveLength(3);
        expect(snapshot.panes.every((pane) => pane.preview === "prompt")).toBe(true);
        expect(maxInflight).toBe(3);
    });

    test("selected preview mode captures only the visible surface per pane", async () => {
        const captured: string[] = [];

        const runJson = async <T>(args: string[]): Promise<T> => {
            if (args[0] === "list-workspaces") {
                return { workspaces: [{ ref: "ws-0" }] } as T;
            }

            if (args[0] === "list-panes") {
                return { panes: [{ ref: "pane-0" }] } as T;
            }

            if (args[0] === "list-pane-surfaces") {
                return {
                    surfaces: [
                        { ref: "surface-hidden", selected_in_pane: false },
                        { ref: "surface-visible", selected_in_pane: true },
                    ],
                } as T;
            }

            return {} as T;
        };

        const run = async (args: string[]) => {
            if (args[0] === "capture-pane") {
                captured.push(args[args.indexOf("--surface") + 1]);
                return { code: 0, stdout: "visible", stderr: "" };
            }

            return { code: 0, stdout: "", stderr: "" };
        };

        const snapshot = await fetchCmuxLiveSnapshot({ runJson, run, previews: "selected" });
        const pane = snapshot.panes[0];

        expect(captured).toEqual(["surface-visible"]);
        expect(pane.surfaces).toHaveLength(2);
        expect(pane.surfaces.find((surface) => surface.id === "surface-hidden")?.preview).toBeUndefined();
        expect(pane.surfaces.find((surface) => surface.id === "surface-visible")?.preview).toBe("visible");
    });

    test("the first state command is bounded and doubles as the probe: a healthy cmux spawns no preflight", async () => {
        const firstOpts: unknown[] = [];
        let probes = 0;
        const runJson = async <T>(args: string[], opts?: unknown): Promise<T> => {
            if (args[0] === "list-workspaces") {
                firstOpts.push(opts);
                return { workspaces: [] } as T;
            }

            return {} as T;
        };
        const snapshot = await fetchCmuxLiveSnapshot({
            runJson,
            run: async () => ({ code: 0, stdout: "", stderr: "" }),
            probe: async () => {
                probes++;
            },
        });

        expect(snapshot.available).toBe(true);
        expect(firstOpts).toEqual([{ timeoutMs: 3_500 }]);
        expect(probes).toBe(0);
    });

    test("a failed first call runs the probe, and its diagnosis is the snapshot's error", async () => {
        const runJson = async <T>(): Promise<T> => {
            throw new Error("cmux list-workspaces failed (1): timed out");
        };
        const run = async () => ({ code: 0, stdout: "", stderr: "" });
        const starved = await fetchCmuxLiveSnapshot({
            runJson,
            run,
            probe: async () => {
                throw new Error("cmux live snapshot: cmux's UI thread is not responding");
            },
        });

        expect(starved.available).toBe(false);
        expect(starved.error).toBe("cmux live snapshot: cmux's UI thread is not responding");

        // A probe that finds cmux healthy leaves the command's own error standing.
        const healthy = await fetchCmuxLiveSnapshot({ runJson, run, probe: async () => undefined });

        expect(healthy.error).toBe("cmux list-workspaces failed (1): timed out");
    });

    test("surfaces come from one tree call, projected to what list-pane-surfaces reports; an unknown pane still asks", async () => {
        const calls: string[][] = [];
        const runJson = async <T>(args: string[]): Promise<T> => {
            calls.push(args);

            if (args[0] === "list-workspaces") {
                return { workspaces: [{ ref: "workspace:1" }] } as T;
            }

            if (args[0] === "list-panes") {
                return { panes: [{ ref: "pane:1" }, { ref: "pane:2" }] } as T;
            }

            if (args[0] === "tree") {
                const surfaces = [
                    { ref: "surface:1", index: 0, index_in_pane: 0, title: "one", type: "terminal", selected: true },
                    { ref: "surface:2", index: 1, title: "two", type: "terminal", active: true, url: null },
                ];
                return {
                    windows: [{ workspaces: [{ ref: "workspace:1", panes: [{ ref: "pane:1", surfaces }] }] }],
                } as T;
            }

            if (args[0] === "list-pane-surfaces") {
                return {
                    surfaces: [{ ref: "surface:3", index: 0, title: "three", type: "terminal", selected: true }],
                } as T;
            }

            return {} as T;
        };
        const snapshot = await fetchCmuxLiveSnapshot({
            runJson,
            run: async () => ({ code: 0, stdout: "", stderr: "" }),
            previews: "none",
        });

        expect(calls.filter((args) => args[0] === "tree")).toEqual([["tree", "--all"]]);
        expect(calls.filter((args) => args[0] === "list-pane-surfaces")).toEqual([
            ["list-pane-surfaces", "--workspace", "workspace:1", "--pane", "pane:2"],
        ]);
        const [first, second] = snapshot.panes;
        expect(first.surfaces.map((surface) => [surface.id, surface.selected, surface.active, surface.url])).toEqual([
            ["surface:1", true, false, undefined],
            ["surface:2", false, false, undefined],
        ]);
        expect(second.surfaces.map((surface) => surface.id)).toEqual(["surface:3"]);
    });
});
