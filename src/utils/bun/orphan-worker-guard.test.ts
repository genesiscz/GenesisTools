import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { skip } from "@genesiscz/utils/test/skip";

const guardPath = join(import.meta.dir, "orphan-worker-guard.ts");
const leftovers: number[] = [];

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }

        await Bun.sleep(50);
    }

    return predicate();
}

async function spawnBusyChild(opts: { guard: boolean }): Promise<{ middlePid: number; childPid: number }> {
    const dir = mkdtempSync(join(tmpdir(), "orphan-worker-"));
    const pidFile = join(dir, "child.pid");
    const readyFile = join(dir, "ready");
    const childSource = opts.guard
        ? `import { installOrphanWorkerGuard } from ${SafeJSON.stringify(guardPath)};
import { writeFileSync } from "node:fs";
installOrphanWorkerGuard();
writeFileSync(${SafeJSON.stringify(readyFile)}, "1");
for (;;) {}`
        : `import { writeFileSync } from "node:fs";
writeFileSync(${SafeJSON.stringify(readyFile)}, "1");
for (;;) {}`;
    const childFile = join(dir, "busy.ts");
    writeFileSync(childFile, childSource);

    const middle = Bun.spawn({
        cmd: [
            process.execPath,
            "-e",
            `
const child = Bun.spawn({
  cmd: [${SafeJSON.stringify(process.execPath)}, ${SafeJSON.stringify(childFile)}],
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
await Bun.write(${SafeJSON.stringify(pidFile)}, String(child.pid));
await Bun.sleep(1 << 30);
`,
        ],
        env: process.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    });
    leftovers.push(middle.pid);

    const ready = await waitUntil(() => {
        try {
            return Bun.file(pidFile).size > 0;
        } catch {
            return false;
        }
    }, 5_000);

    if (!ready) {
        throw new Error("middle process never wrote the child pid");
    }

    const childPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
    leftovers.push(childPid);

    if (!Number.isFinite(childPid) || childPid <= 0) {
        throw new Error(`invalid child pid: ${childPid}`);
    }

    const armed = await waitUntil(() => {
        try {
            return Bun.file(readyFile).size > 0;
        } catch {
            return false;
        }
    }, 5_000);

    if (!armed) {
        throw new Error("child never armed (ready file missing)");
    }

    return { middlePid: middle.pid, childPid };
}

afterEach(() => {
    for (const pid of leftovers.splice(0)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
});

describe.skipIf(skip.onWindows)("orphan isolate-worker guard", () => {
    test("a busy-loop child survives SIGKILL of its parent (the 2026-09-08 class)", async () => {
        const { middlePid, childPid } = await spawnBusyChild({ guard: false });

        expect(pidAlive(childPid)).toBe(true);
        process.kill(middlePid, "SIGKILL");

        const stillAlive = await waitUntil(() => !pidAlive(middlePid), 2_000);
        expect(stillAlive).toBe(true);
        await Bun.sleep(1_500);
        expect(pidAlive(childPid)).toBe(true);
    });

    test("the guard SIGKILLs the child once the parent is gone", async () => {
        const { middlePid, childPid } = await spawnBusyChild({ guard: true });

        expect(pidAlive(childPid)).toBe(true);
        process.kill(middlePid, "SIGKILL");

        const died = await waitUntil(() => !pidAlive(childPid), 4_000);
        expect(died).toBe(true);
    });
});
