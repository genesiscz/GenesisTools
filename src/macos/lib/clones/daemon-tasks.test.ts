import { describe, expect, it, mock } from "bun:test";
import { existsSync } from "node:fs";
import { escapeShellArg } from "@genesiscz/utils/string";

const registerSpy = mock(async () => true);
mock.module("@app/daemon/lib/register", () => ({
    registerTask: registerSpy,
    unregisterTask: mock(async () => true),
    isTaskRegistered: mock(async () => false),
}));
const getTaskSpy = mock(async (_name: string): Promise<{ command: string } | undefined> => undefined);
mock.module("@app/daemon/lib/config", () => ({ getTask: getTaskSpy }));

const { ensureClonesDaemonTasks, resolvePruneCommand, resolveScanCommand, scriptOfCommand } = await import(
    "@app/macos/lib/clones/daemon-tasks"
);

function scriptOf(command: string): string {
    const m = /run '([^']+)'$/.exec(command);
    if (m === null) {
        throw new Error(`unexpected command shape: ${command}`);
    }

    return m[1];
}

describe("clones daemon tasks", () => {
    it("recovers the script path from a command even when the path holds an apostrophe", () => {
        for (const path of ["/Users/dev/repo/x.ts", "/Users/dev/O'Brien/repo/cache-prune-daemon.ts", "/a b/c'd'e.ts"]) {
            expect(scriptOfCommand(`${escapeShellArg("/opt/bun")} run ${escapeShellArg(path)}`)).toBe(path);
        }

        expect(scriptOfCommand("bun run unquoted.ts")).toBeNull();
    });

    it("resolves both scripts to absolute paths that exist on disk", () => {
        for (const cmd of [resolveScanCommand(), resolvePruneCommand()]) {
            const script = scriptOf(cmd);
            expect(script.startsWith("/")).toBe(true);
            expect(existsSync(script)).toBe(true);
        }

        expect(scriptOf(resolveScanCommand())).toEndWith("/src/macos/lib/clones/scan-daemon.ts");
        expect(scriptOf(resolvePruneCommand())).toEndWith("/src/macos/lib/clones/cache-prune-daemon.ts");
    });

    it("without overwrite: writes a missing task, repairs one whose script is gone, leaves any other alone", async () => {
        registerSpy.mockClear();
        getTaskSpy.mockImplementation(async (name: string) =>
            name === "macos-clones-scan"
                ? { command: `'/custom/bun' run '${scriptOf(resolveScanCommand())}'` }
                : { command: "'/old/bun' run '/definitely/gone/cache-prune-daemon.ts'" }
        );
        const done = await ensureClonesDaemonTasks({ overwrite: false });
        expect(done).toEqual({ scan: false, prune: true });
        expect(registerSpy.mock.calls.length).toBe(1);

        registerSpy.mockClear();
        getTaskSpy.mockImplementation(async () => undefined);
        expect(await ensureClonesDaemonTasks({ overwrite: false })).toEqual({ scan: true, prune: true });
        expect(registerSpy.mock.calls.length).toBe(2);
    });

    it("with overwrite: always writes both", async () => {
        registerSpy.mockClear();
        getTaskSpy.mockImplementation(async (name: string) => ({
            command: name === "macos-clones-scan" ? resolveScanCommand() : resolvePruneCommand(),
        }));
        expect(await ensureClonesDaemonTasks({ overwrite: true })).toEqual({ scan: true, prune: true });
        expect(registerSpy.mock.calls.length).toBe(2);
    });
});
