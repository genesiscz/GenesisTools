import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";

setupStorageSandbox();

import { describe, expect, it } from "bun:test";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { stopSession } from "@app/task/lib/stop-session";
import { isProcessAlive } from "@genesiscz/utils/process-alive";

describe("stopSession", () => {
    it("SIGTERM alone is enough for a child that honours it — no SIGKILL, marked stopped", async () => {
        const store = new TaskSessionStore();
        const name = "stop-term-ok";
        await store.prepareSession({ name, command: "sleep 5", mode: "pipe", cwd: "/tmp" });

        const child = Bun.spawn(["bash", "-c", "sleep 5"], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
            env: process.env,
        });
        await store.updatePid(name, child.pid);

        const outcome = await stopSession({ name, graceMs: 2000 });

        expect(outcome.status).toBe("stopped");
        if (outcome.status === "stopped") {
            expect(outcome.termedPids).toContain(child.pid);
            expect(outcome.killedPids).toEqual([]);
        }

        await child.exited;
        expect(isProcessAlive(child.pid)).toBe(false);

        const meta = await store.getSessionMeta(name);
        expect(meta?.stopped).toBe(true);
        expect(meta?.exitCode).toBeUndefined();
    });

    it("escalates to SIGKILL once the grace period passes for a child that ignores SIGTERM", async () => {
        const store = new TaskSessionStore();
        const name = "stop-term-trap";
        await store.prepareSession({ name, command: "trap-term", mode: "pipe", cwd: "/tmp" });

        // SIG_IGN set before a shell execs its single simple command survives
        // the exec (POSIX: only handler dispositions reset, SIG_IGN does not),
        // so this pid genuinely ignores SIGTERM — confirmed empirically before
        // writing this test.
        const child = Bun.spawn(["bash", "-c", "trap '' TERM; sleep 5"], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
            env: process.env,
        });
        await store.updatePid(name, child.pid);

        const outcome = await stopSession({ name, graceMs: 150 });

        expect(outcome.status).toBe("stopped");
        if (outcome.status === "stopped") {
            expect(outcome.killedPids).toContain(child.pid);
        }

        await child.exited;
        expect(isProcessAlive(child.pid)).toBe(false);

        const meta = await store.getSessionMeta(name);
        expect(meta?.stopped).toBe(true);
    }, 10_000);

    it("signals the whole process tree, not just the recorded root pid", async () => {
        const store = new TaskSessionStore();
        const name = "stop-tree";
        await store.prepareSession({ name, command: "tree", mode: "pipe", cwd: "/tmp" });

        // "sleep & wait" forces bash to stay resident as a real parent (unlike a
        // single simple command, which execs in place) — confirmed empirically
        // to produce two distinct pids with a real ppid relationship.
        const child = Bun.spawn(["bash", "-c", "sleep 5 & wait"], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
            env: process.env,
        });
        await store.updatePid(name, child.pid);
        await Bun.sleep(300); // let bash fork its sleep child before the kill snapshots the tree

        const outcome = await stopSession({ name, graceMs: 2000 });

        expect(outcome.status).toBe("stopped");
        if (outcome.status === "stopped") {
            expect(outcome.termedPids.length).toBeGreaterThanOrEqual(2);
            expect(outcome.termedPids).toContain(child.pid);
        }

        await child.exited;
    });

    it("already-exited and already-stopped sessions report their prior state without signalling anything", async () => {
        const store = new TaskSessionStore();

        const exitedName = "stop-already-exited";
        await store.prepareSession({ name: exitedName, command: "echo hi", mode: "pipe", cwd: "/tmp" });
        await store.markExited({ name: exitedName, exitCode: 0, durationMs: 10 });
        expect(await stopSession({ name: exitedName })).toEqual({
            status: "already-finished",
            previousState: "exited",
        });

        const stoppedName = "stop-already-stopped";
        await store.prepareSession({ name: stoppedName, command: "echo hi", mode: "pipe", cwd: "/tmp" });
        await store.markStopped({ name: stoppedName, durationMs: 10 });
        expect(await stopSession({ name: stoppedName })).toEqual({
            status: "already-finished",
            previousState: "stopped",
        });
    });

    it("a session with no recorded pid is simply marked stopped", async () => {
        const store = new TaskSessionStore();
        const name = "stop-no-pid";
        await store.prepareSession({ name, command: "echo hi", mode: "pipe", cwd: "/tmp" });

        const outcome = await stopSession({ name });

        expect(outcome).toEqual({ status: "no-pid" });
        expect((await store.getSessionMeta(name))?.stopped).toBe(true);
    });

    it("an unknown session name reports not-found", async () => {
        expect(await stopSession({ name: "no-such-session-at-all" })).toEqual({ status: "not-found" });
    });
});
