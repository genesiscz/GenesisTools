import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as offline from "@app/cmux/lib/offline-snapshot";
import { ProfileStore } from "@app/cmux/lib/store";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import * as prompts from "@clack/prompts";
import * as health from "@genesiscz/utils/cmux/lib/health";
import { runRescue } from "./rescue";

/**
 * The confirmation gate is the only thing between `tools cmux rescue` and
 * killing the user's terminal app. Per the repo's side-effects rule the spy
 * both RECORDS and THROWS, so a path that reaches the kill fails loudly rather
 * than passing quietly — and the last test is the negative control proving a
 * confirmed run still gets there.
 *
 * Only `spyOn` + `mock.restore()` here, never `mock.module`: a module mock is
 * process-global in Bun and outlives this file. The store mock this file used
 * to install had no `read`, so every later file in a serial run (`bun
 * scripts/test.ts src/cmux`) got a ProfileStore without `read`, `list` or
 * `exists`.
 */

let interactive = true;
let confirmAnswer: boolean | symbol = true;
let realIsTty: boolean | undefined;

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

    // `isInteractive()` reads `process.stdin.isTTY`; a getter lets a test flip it.
    realIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { get: () => interactive, configurable: true });

    spyOn(health, "probeCmuxHealth").mockResolvedValue({
        state: "ui-starved",
        appPid: 4242,
        appCpu: 99,
        probes: { ping: { ok: true, ms: 1 }, identify: { ok: false, ms: 1 } },
    });
    spyOn(offline, "captureOfflineProfile").mockResolvedValue({
        version: PROFILE_VERSION,
        name: "rescue",
        scope: "all",
        captured_at: "2026-08-27T12:00:00.000Z",
        cmux_version: "test",
        windows: [],
    });
    spyOn(ProfileStore.prototype, "write").mockReturnValue("/tmp/does-not-matter.json");
    spyOn(prompts, "confirm").mockImplementation(async () => confirmAnswer);

    for (const name of ["intro", "outro", "note", "cancel"] as const) {
        spyOn(prompts, name).mockImplementation(() => {});
    }

    for (const name of ["info", "warn", "step"] as const) {
        spyOn(prompts.log, name).mockImplementation(() => {});
    }
});

afterEach(() => {
    mock.restore();
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTty, configurable: true, writable: true });
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
