import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { capture } from "@genesiscz/utils/process/ps";
import {
    disableFsmonitor,
    enableFsmonitor,
    type FsmonitorDeps,
    type FsmonitorState,
    listMonitorDaemons,
    readFsmonitorState,
    readGlobal,
    recordMonitorDaemons,
    worktreesFromLsof,
} from "./fsmonitor";

const DAEMON = "/opt/homebrew/opt/git/libexec/git-core/git fsmonitor--daemon run --detach --ipc-threads=8";

/**
 * A main checkout `repo`, a linked worktree `wt1` of `main`, and canned `ps` / `lsof` output for their daemons.
 * git config runs for real against a global file inside the fixture; stop and update-index are only recorded.
 */
function fixture({ running = ["repo", "wt1"], stopFails = false }: { running?: string[]; stopFails?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "gt-fsmonitor-"));
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "main", ".git", "worktrees", "wt1"), { recursive: true });
    mkdirSync(join(root, "wt1"), { recursive: true });
    writeFileSync(join(root, "main", ".git", "worktrees", "wt1", "gitdir"), `${join(root, "wt1", ".git")}\n`);
    const sockets: Record<string, string> = {
        repo: join(root, "repo", ".git", "fsmonitor--daemon.ipc"),
        wt1: join(root, "main", ".git", "worktrees", "wt1", "fsmonitor--daemon.ipc"),
    };
    const pids: Record<string, number> = { repo: 101, wt1: 102 };
    const ps = [
        "  PID   RSS      TIME COMMAND",
        ...running.map((name) => `  ${pids[name]}  7920   0:00.25 ${DAEMON}`),
        "  103   100   0:00.00 /bin/zsh -l",
    ].join("\n");
    // As `lsof -F pftn` prints it: a folder above the worktree, the worktree folder, and the socket. A linked
    // worktree binds its socket by the bare name, so only the folder handle names it.
    const lsof = running
        .map((name) =>
            [
                `p${pids[name]}`,
                "f5",
                "tDIR",
                `n${root}`,
                "f4",
                "tDIR",
                `n${join(root, name)}`,
                "f17",
                "tunix",
                `n${name === "repo" ? sockets.repo : "fsmonitor--daemon.ipc"}`,
            ].join("\n")
        )
        .join("\n");
    const calls: string[][] = [];
    const deps: FsmonitorDeps = {
        statePath: join(root, "state", "fsmonitor.json"),
        globalConfigPath: join(root, "gitconfig"),
        now: () => new Date("2026-10-12T22:00:00.000Z"),
        run: async (command, args, options) => {
            calls.push([command, ...args]);

            if (command === "ps") {
                return { stdout: ps, stderr: "", status: 0 };
            }

            if (command === "lsof") {
                return { stdout: lsof, stderr: "", status: lsof ? 0 : 1 };
            }

            if (args.includes("fsmonitor--daemon")) {
                return stopFails
                    ? { stdout: "", stderr: "fsmonitor-daemon is not watching", status: 1 }
                    : { stdout: "", stderr: "", status: 0 };
            }

            if (args.includes("update-index")) {
                return { stdout: "", stderr: "", status: 0 };
            }

            return capture(command, args, options);
        },
    };

    return { root, deps, calls, worktree: (name: string) => join(root, name) };
}

describe("git fsmonitor", () => {
    test("lists each daemon with the worktree its socket names, for a main checkout and a linked worktree", async () => {
        const { deps, worktree } = fixture();

        expect(await listMonitorDaemons(deps)).toEqual([
            { pid: 101, worktree: worktree("repo"), rssKb: 7920, cpuMs: 250 },
            { pid: 102, worktree: worktree("wt1"), rssKb: 7920, cpuMs: 250 },
        ]);
    });

    test("without a folder handle the socket names the worktree, also through a linked worktree's gitdir file", () => {
        const { root, worktree } = fixture();
        const output = [
            "p201",
            "f17",
            "tunix",
            `n${join(root, "repo", ".git", "fsmonitor--daemon.ipc")}`,
            "p202",
            "f17",
            "tunix",
            `n${join(root, "main", ".git", "worktrees", "wt1", "fsmonitor--daemon.ipc")}`,
            "p203",
            "f17",
            "tunix",
            "nfsmonitor--daemon.ipc",
        ].join("\n");

        expect(worktreesFromLsof(output)).toEqual(
            new Map([
                [201, worktree("repo")],
                [202, worktree("wt1")],
            ])
        );
    });

    test("no daemon running: no lsof call and an empty list", async () => {
        const { deps, calls } = fixture({ running: [] });

        expect(await listMonitorDaemons(deps)).toEqual([]);
        expect(calls.map((call) => call[0])).toEqual(["ps"]);
    });

    test("listing writes nothing; record keeps the first sighting and moves the last", async () => {
        const { deps, worktree } = fixture();

        await listMonitorDaemons(deps);
        expect(existsSync(deps.statePath)).toBe(false);

        const first = await recordMonitorDaemons(deps);
        expect(first.added).toEqual([worktree("repo"), worktree("wt1")]);

        const later = await recordMonitorDaemons({ ...deps, now: () => new Date("2026-10-12T23:00:00.000Z") });
        expect(later.added).toEqual([]);
        expect(readFsmonitorState(deps.statePath).worktrees[worktree("repo")]).toEqual({
            firstSeen: "2026-10-12T22:00:00.000Z",
            lastSeen: "2026-10-12T23:00:00.000Z",
        });
    });

    test("enable keeps the earlier values once; disable puts back exactly those and leaves the rest of the file", async () => {
        const { deps } = fixture({ running: [] });
        writeFileSync(deps.globalConfigPath ?? "", "[user]\n\tname = Test\n[core]\n\tuntrackedCache = keep\n");

        const first = await enableFsmonitor(deps);
        expect(first).toEqual({
            previous: { "core.fsmonitor": null, "core.untrackedCache": "keep" },
            alreadyEnabled: false,
        });
        expect(await readGlobal(deps, "core.fsmonitor")).toBe("true");
        expect(await readGlobal(deps, "core.untrackedCache")).toBe("true");

        // A second enable must not record "true" as the value to restore.
        const again = await enableFsmonitor(deps);
        expect(again).toEqual({ previous: first.previous, alreadyEnabled: true });

        const report = await disableFsmonitor(deps);
        expect(report.restored).toEqual(first.previous);
        expect(await readGlobal(deps, "core.fsmonitor")).toBeNull();
        expect(await readGlobal(deps, "core.untrackedCache")).toBe("keep");
        expect(readFileSync(deps.globalConfigPath ?? "", "utf8")).toContain("name = Test");
        expect(readFsmonitorState(deps.statePath)).toEqual({
            version: 1,
            enabledAt: null,
            previous: null,
            worktrees: {},
        } satisfies FsmonitorState);
    });

    test("disable restores the config before it stops a daemon, cleans every recorded worktree, skips missing ones", async () => {
        const { deps, calls, worktree, root } = fixture({ running: ["repo"] });
        await enableFsmonitor(deps);
        await recordMonitorDaemons(deps);
        const state = readFsmonitorState(deps.statePath);
        state.worktrees[worktree("wt1")] = { firstSeen: "x", lastSeen: "x" };
        state.worktrees[join(root, "gone")] = { firstSeen: "x", lastSeen: "x" };
        writeFileSync(deps.statePath, SafeJSON.stringify(state));
        calls.length = 0;

        const report = await disableFsmonitor(deps);
        const steps = calls.map((call) => call.slice(1).join(" "));
        const lastConfigWrite = steps.findLastIndex((step) => step.startsWith("config --global --unset-all"));
        const firstStop = steps.findIndex((step) => step.includes("fsmonitor--daemon stop"));

        expect(lastConfigWrite).toBeGreaterThanOrEqual(0);
        expect(firstStop).toBeGreaterThan(lastConfigWrite);
        expect(report.stopped).toEqual([worktree("repo")]);
        expect(report.cacheRemoved).toEqual([worktree("repo"), worktree("wt1")]);
        expect(report.missing).toEqual([join(root, "gone")]);
        expect(report.failed).toEqual([]);
    });

    test("--keep-cache, or an untracked cache the user had on before, leaves every index alone", async () => {
        const kept = fixture({ running: ["repo"] });
        await enableFsmonitor(kept.deps);
        await disableFsmonitor(kept.deps, { keepCache: true });
        expect(kept.calls.some((call) => call.includes("update-index"))).toBe(false);

        const before = fixture({ running: ["repo"] });
        writeFileSync(before.deps.globalConfigPath ?? "", "[core]\n\tuntrackedCache = true\n");
        await enableFsmonitor(before.deps);
        await disableFsmonitor(before.deps);
        expect(before.calls.some((call) => call.includes("update-index"))).toBe(false);
    });

    test("a daemon that will not stop stays on the recorded list and fails the report", async () => {
        const { deps, worktree } = fixture({ running: ["repo"], stopFails: true });
        await enableFsmonitor(deps);
        await recordMonitorDaemons(deps);

        const report = await disableFsmonitor(deps);

        expect(report.failed).toEqual([
            { worktree: worktree("repo"), step: "stop", error: "fsmonitor-daemon is not watching" },
        ]);
        expect(Object.keys(readFsmonitorState(deps.statePath).worktrees)).toEqual([worktree("repo")]);
    });
});
