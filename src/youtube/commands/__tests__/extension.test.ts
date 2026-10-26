import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { env } from "@genesiscz/utils/env";

const spawnCalls: string[][] = [];
const spawnEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
const originalSpawn = Bun.spawn;

function mockSpawn(exitCode: number): void {
    Bun.spawn = ((cmd: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        spawnCalls.push(cmd);
        spawnEnvs.push(
            options?.env
                ? { NODE_ENV: options.env.NODE_ENV, EXT_TARGET: options.env.EXT_TARGET, EXT_DEV: options.env.EXT_DEV }
                : undefined
        );
        return { exited: Promise.resolve(exitCode) };
    }) as typeof Bun.spawn;
}

describe("youtube extension command", () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        spawnEnvs.length = 0;
        mockSpawn(0);
    });

    afterEach(() => {
        Bun.spawn = originalSpawn;
        mock.restore();
    });

    it.each([false, true])("builds both targets in production with devReload=%s", async (devReload) => {
        // The mocked spawn writes no bundle, so the check that the build wrote every file the manifest names,
        // and the build stamp, are stubbed here: this test covers the command line and build environment.
        mock.module("@genesiscz/utils/browser-extension/build-info", () => ({
            missingManifestFiles: async () => [],
            newBuildId: () => "test-build",
            writeBuildInfo: async () => {},
        }));
        const { buildExtension } = await import("@app/youtube/commands/extension");

        await env.testing.withOverrides(
            { NODE_ENV: "development", EXT_DEV: "parent", EXT_TARGET: "parent" },
            async () => {
                const dist = await buildExtension({ devReload });

                expect(spawnCalls).toHaveLength(2);
                expect(spawnEnvs).toHaveLength(2);

                for (const [index, target] of ["modules", "content-script"].entries()) {
                    expect(spawnCalls[index]?.slice(0, 4)).toEqual(["bun", "--bun", "vite", "build"]);
                    expect(spawnCalls[index]).toContain("-c");
                    expect(spawnEnvs[index]).toMatchObject({
                        NODE_ENV: "production",
                        EXT_TARGET: target,
                        EXT_DEV: devReload ? "1" : "0",
                    });
                }

                expect(env.get("NODE_ENV")).toBe("development");
                expect(dist.endsWith("dist/extension")).toBe(true);
            }
        );
    });
});
