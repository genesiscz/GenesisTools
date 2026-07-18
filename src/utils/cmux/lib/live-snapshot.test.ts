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
});
