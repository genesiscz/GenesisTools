import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fakeDriver } from "../../fs/watch-driver/fake";
import { TestRepo } from "../../git/test-repo";
import { startGenesisToolsService } from "../service/host";
import { createWorktreeService } from "./service";
import { callWorktreeSnapshot } from "./thin-client";

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
