import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const spawnCalls: string[][] = [];
const originalSpawn = Bun.spawn;

function mockSpawn(exitCode: number): void {
    Bun.spawn = ((cmd: string[]) => {
        spawnCalls.push(cmd);
        return { exited: Promise.resolve(exitCode) };
    }) as typeof Bun.spawn;
}

describe("youtube extension command", () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        mockSpawn(0);
    });

    afterEach(() => {
        Bun.spawn = originalSpawn;
        mock.restore();
    });

    it("runs the Vite extension build", async () => {
        const { buildExtension } = await import("@app/youtube/commands/extension");

        const dist = await buildExtension();

        expect(spawnCalls[0]?.slice(0, 4)).toEqual(["bun", "--bun", "vite", "build"]);
        expect(spawnCalls[0]).toContain("-c");
        expect(dist.endsWith("dist/extension")).toBe(true);
    });
});
