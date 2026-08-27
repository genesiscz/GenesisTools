import { describe, expect, test } from "bun:test";
import { fetchCmuxLiveSnapshot } from "./live-snapshot";

describe("fetchCmuxLiveSnapshot", () => {
    test("fetches all workspaces in parallel, not sequentially", async () => {
        const delays = [50, 50, 50];

        const runJson = async <T>(args: string[]): Promise<T> => {
            if (args[0] === "list-workspaces") {
                return { workspaces: [{ ref: "ws-0" }, { ref: "ws-1" }, { ref: "ws-2" }] } as T;
            }

            if (args[0] === "list-panes") {
                const idx = Number(args[args.indexOf("--workspace") + 1].split("-")[1]);
                await new Promise((r) => setTimeout(r, delays[idx] ?? 10));
                return { panes: [] } as T;
            }

            return {} as T;
        };

        const run = async () => ({ code: 0, stdout: "", stderr: "" });

        const start = Date.now();
        const snapshot = await fetchCmuxLiveSnapshot({ runJson, run });
        const elapsed = Date.now() - start;

        expect(snapshot.available).toBe(true);
        expect(elapsed).toBeLessThan(110);
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
});
