import { beforeEach, expect, mock, test } from "bun:test";

/**
 * The confirmation gate is the only thing between `tools cmux rescue` and
 * killing the user's terminal app. Per the repo's side-effects rule the spy
 * both RECORDS and THROWS, so a path that reaches the kill fails loudly rather
 * than passing quietly — and the last test is the negative control proving a
 * confirmed run still gets there.
 */

let interactive = true;
let confirmAnswer: boolean | symbol = true;

mock.module("@genesiscz/utils/cli", () => ({
    isInteractive: () => interactive,
    suggestCommand: (cmd: string) => cmd,
}));

mock.module("@genesiscz/utils/prompts/clack/helpers", () => ({
    withCancel: async (value: unknown) => await value,
}));

mock.module("@clack/prompts", () => ({
    intro: () => {},
    outro: () => {},
    note: () => {},
    cancel: () => {},
    confirm: async () => confirmAnswer,
    log: { info: () => {}, warn: () => {}, step: () => {}, error: () => {}, success: () => {} },
}));

mock.module("@genesiscz/utils/cmux/lib/health", () => ({
    probeCmuxHealth: async () => ({ state: "starved", appPid: 4242, appCpu: 99 }),
    // Mocking a module replaces ALL of its exports; the rescue lib reads this one
    // to re-check a pid's identity before signalling, so it has to be here too.
    APP_BINARY_SUFFIX: "cmux.app/Contents/MacOS/cmux",
}));

mock.module("@app/cmux/lib/offline-snapshot", () => ({
    captureOfflineProfile: async () => ({
        version: 1,
        name: "rescue",
        scope: "all",
        captured_at: "2026-08-27T12:00:00.000Z",
        cmux_version: "test",
        windows: [],
    }),
}));

mock.module("@app/cmux/lib/store", () => ({
    ProfileStore: class {
        write() {
            return "/tmp/does-not-matter.json";
        }
    },
    ProfileExistsError: class extends Error {},
}));

const { runRescue } = await import("./rescue");

let killed: number[] = [];
let relaunched = 0;

const explodingDeps = {
    killApp: async (pid: number) => {
        killed.push(pid);
        throw new Error("the kill path must not be reached on this run");
    },
    relaunch: async () => {
        relaunched += 1;
        throw new Error("the relaunch path must not be reached on this run");
    },
};

beforeEach(() => {
    killed = [];
    relaunched = 0;
    interactive = true;
    confirmAnswer = true;
});

test("--dry-run never reaches the kill", async () => {
    await runRescue("rescue", { dryRun: true }, explodingDeps);

    expect(killed).toEqual([]);
});

test("non-interactive without --yes never reaches the kill", async () => {
    interactive = false;

    await runRescue("rescue", {}, explodingDeps);

    expect(killed).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
});

test("a declined confirmation never reaches the kill", async () => {
    confirmAnswer = false;

    await runRescue("rescue", {}, explodingDeps);

    expect(killed).toEqual([]);
});

test("NEGATIVE CONTROL — a confirmed run does reach the kill", async () => {
    // Without this, a guard that accidentally blocks the normal path would pass
    // every test above while breaking the command outright.
    confirmAnswer = true;

    await expect(runRescue("rescue", {}, explodingDeps)).rejects.toThrow("the kill path must not be reached");
    expect(killed).toEqual([4242]);
});

test("a cmux that survives the kill stops the rescue before the relaunch", async () => {
    // `open -a cmux` would activate the still-livelocked app, the health wait
    // would pass against that old instance, and replay would type every captured
    // command into the frozen surfaces.
    const survivingDeps = {
        killApp: async (pid: number) => {
            killed.push(pid);

            return { signals: ["SIGTERM", "SIGKILL"] as NodeJS.Signals[], exited: false };
        },
        relaunch: explodingDeps.relaunch,
    };

    await expect(runRescue("rescue", {}, survivingDeps)).rejects.toThrow("did not terminate");
    expect(killed).toEqual([4242]);
    expect(relaunched).toBe(0);
});

test("NEGATIVE CONTROL — a cmux that DID exit reaches the relaunch", async () => {
    // Without this, a guard that blocked the normal path would satisfy the test
    // above while breaking every real rescue.
    const exitedDeps = {
        killApp: async (pid: number) => {
            killed.push(pid);

            return { signals: ["SIGTERM"] as NodeJS.Signals[], exited: true };
        },
        relaunch: explodingDeps.relaunch,
    };

    await expect(runRescue("rescue", {}, exitedDeps)).rejects.toThrow("the relaunch path must not be reached");
    expect(killed).toEqual([4242]);
    expect(relaunched).toBe(1);
});
