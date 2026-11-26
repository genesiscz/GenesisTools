import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDriver } from "../../fs/watch-driver/fake";
import type { WatchDriver, WatchOpen } from "../../fs/watch-driver/types";
import { TestRepo } from "../../git/test-repo";
import { SafeJSON } from "../../json";
import { startGenesisToolsService } from "../service/host";
import { createWorktreeService } from "./service";
import { callWorktreeSnapshot, requestServiceStart } from "./thin-client";

describe("worktree.snapshot through the service and the thin client", () => {
    let repo: TestRepo;
    let dir: string;
    const driver = fakeDriver();
    let stop: () => Promise<void> = async () => {};

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "worktree-service-" });
        await repo.commitMany({ files: { "a.txt": "a\n" }, message: "base" });
        // A short folder: a unix socket path has a 104-byte limit on macOS.
        dir = realpathSync(mkdtempSync("/tmp/gtwt-"));
        const started = await startGenesisToolsService({
            dir,
            idleMs: 60_000,
            worktree: createWorktreeService({ drivers: { watchman: driver } }),
        });

        if (started.status !== "started") {
            throw new Error("the isolated service did not start");
        }

        stop = async () => {
            started.host.stop("test over");
            await started.host.stopped;
        };
    });

    afterAll(async () => {
        await stop();
        repo.cleanup();
        rmSync(dir, { recursive: true, force: true });
    });

    it("answers opening, then ok with the status, then the changes since a mark", async () => {
        const params = { root: repo.dir, driver: "watchman" as const };
        const first = await callWorktreeSnapshot(params, { deadlineMs: 5_000, dir });
        expect(first.ok && first.result).toEqual({ state: "unavailable", reason: "opening" });

        let second = await callWorktreeSnapshot(params, { deadlineMs: 5_000, dir });

        for (let tries = 0; tries < 50 && second.ok && second.result.state !== "ok"; tries++) {
            await Bun.sleep(100);
            second = await callWorktreeSnapshot(params, { deadlineMs: 5_000, dir });
        }

        expect(second.ok && second.result.state).toBe("ok");
        const mark = second.ok && second.result.state === "ok" ? second.result.mark : "";
        expect(mark.startsWith("v1:watchman:fake-1:")).toBe(true);

        appendFileSync(join(repo.dir, "a.txt"), "edit\n");
        driver.emit(repo.dir, [{ path: "a.txt", exists: true }]);
        const third = await callWorktreeSnapshot({ ...params, since: mark }, { deadlineMs: 5_000, dir });
        expect(third.ok && third.result.state === "ok" && third.result.changed).toEqual([
            { path: "a.txt", exists: true },
        ]);
        expect(third.ok && third.result.state === "ok" && third.result.entries.map((entry) => entry.path)).toEqual([
            "a.txt",
        ]);
    });

    it("an opening root reserves capacity and closes a watch resolved after disposal", async () => {
        let resolveOpen: (value: WatchOpen) => void = () => {};
        let closed = 0;
        const pending: WatchDriver = {
            facts: driver.facts,
            available: driver.available,
            dispose: async () => {},
            open: () =>
                new Promise((resolve) => {
                    resolveOpen = resolve;
                }),
        };
        const service = createWorktreeService({ drivers: { watchman: pending }, maxRoots: 1 });
        const other = await TestRepo.create({ prefix: "worktree-capacity-" });
        try {
            const signal = new AbortController().signal;
            expect(await service.snapshot({ root: repo.dir, driver: "watchman" }, signal)).toEqual({
                state: "unavailable",
                reason: "opening",
            });
            await Promise.resolve();
            expect(await service.snapshot({ root: other.dir, driver: "watchman" }, signal)).toEqual({
                state: "unavailable",
                reason: "over-capacity",
            });
            await service.dispose();
            resolveOpen({
                ok: true,
                watched: {
                    instance: "delayed",
                    changesSince: async () => ({ kind: "lost", reason: "closed" }),
                    close: async () => {
                        closed++;
                    },
                },
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(closed).toBe(1);
        } finally {
            await service.dispose();
            other.cleanup();
        }
    });

    it("failed inventory seeding closes its watch", async () => {
        let closed = 0;
        let failed!: () => void;
        const failedSeed = new Promise<void>((resolve) => {
            failed = resolve;
        });
        const failing: WatchDriver = {
            facts: driver.facts,
            available: driver.available,
            dispose: async () => {},
            open: async () => ({
                ok: true,
                watched: {
                    instance: "failed",
                    changesSince: async () => ({ kind: "lost", reason: "driver-error" }),
                    close: async () => {
                        closed++;
                        failed();
                    },
                },
            }),
        };
        const service = createWorktreeService({ drivers: { watchman: failing } });
        await service.snapshot({ root: repo.dir, driver: "watchman" }, new AbortController().signal);
        await failedSeed;
        expect(closed).toBe(1);
        expect(service.watchers()).toEqual([]);
        await service.dispose();
    });

    it("a peer cannot retain an unterminated oversized response", async () => {
        const peerDir = realpathSync(mkdtempSync("/tmp/gt-frame-"));
        const unix = join(peerDir, "peer.sock");
        const oversized = "x".repeat(8 * 1024 * 1024 + 1);
        let sent = 0;
        const listener = Bun.listen({
            unix,
            socket: {
                open(socket) {
                    sent += socket.write(oversized.slice(sent));
                },
                data() {},
                drain(socket) {
                    sent += socket.write(oversized.slice(sent));
                },
            },
        });
        try {
            writeFileSync(join(peerDir, "service.json"), SafeJSON.stringify({ pid: process.pid, socket: unix }));
            const answer = await callWorktreeSnapshot(
                { root: repo.dir, driver: "watchman" },
                { deadlineMs: 2_000, dir: peerDir }
            );
            expect(answer).toMatchObject({ ok: false, reason: "rpc-error" });
        } finally {
            listener.stop(true);
            rmSync(peerDir, { recursive: true, force: true });
        }
    });

    it("startup is guarded even with a scratch directory and concurrent injected launches share one claim", async () => {
        const stampDir = join(dir, "startup");
        await requestServiceStart({ dir: stampDir });
        expect(existsSync(stampDir)).toBe(false);
        let starts = 0;
        await Promise.all(
            Array.from({ length: 10 }, () =>
                requestServiceStart({
                    dir: stampDir,
                    launch: async () => {
                        starts++;
                    },
                })
            )
        );
        expect(starts).toBe(1);
        await requestServiceStart({
            dir: join(stampDir, "start-request.stamp", "bad"),
            launch: async () => {
                starts++;
            },
        });
        expect(starts).toBe(1);
    });

    it("an unknown root is not-a-worktree, and a held fence makes the thin client time out as ok: false", async () => {
        const unknown = await callWorktreeSnapshot(
            { root: join(dir, "nowhere"), driver: "watchman" },
            { deadlineMs: 5_000, dir }
        );
        expect(unknown.ok && unknown.result).toEqual({ state: "unavailable", reason: "not-a-worktree" });

        const release = driver.hold(repo.dir);
        const timedOut = await callWorktreeSnapshot(
            { root: repo.dir, driver: "watchman", fenceMs: 2_000 },
            { deadlineMs: 50, dir }
        );
        release();
        expect(timedOut).toMatchObject({ ok: false, reason: "timeout" });
        expect((await callWorktreeSnapshot({ root: repo.dir, driver: "watchman" }, { deadlineMs: 50 })).ok).toBe(false);
    });
});
