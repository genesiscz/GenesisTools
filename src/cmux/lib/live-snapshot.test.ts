import { describe, expect, mock, test } from "bun:test";

describe("fetchCmuxLiveSnapshot", () => {
    test("fetches all workspaces in parallel, not sequentially", async () => {
        const delays = [50, 50, 50];

        const fakeRunCmux = mock(async (_ws: string, idx: number) => {
            await new Promise((r) => setTimeout(r, delays[idx] ?? 10));
            return { workspaceIndex: idx };
        });

        const { fetchCmuxLiveSnapshotWithRunner } = await import("./live-snapshot");
        const start = Date.now();
        await fetchCmuxLiveSnapshotWithRunner(["a", "b", "c"], fakeRunCmux);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(110);
    });
});
