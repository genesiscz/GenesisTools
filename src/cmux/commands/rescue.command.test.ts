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

const explodingDeps = {
    killApp: async (pid: number) => {
        killed.push(pid);
        throw new Error("the kill path must not be reached on this run");
    },
};

beforeEach(() => {
    killed = [];
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
