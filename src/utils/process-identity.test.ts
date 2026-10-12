import { describe, expect, it, spyOn } from "bun:test";
import { classifyPid, processStartMs, readProcessCommand, START_MS_TOLERANCE } from "@genesiscz/utils/process-identity";

/** Above macOS/Linux pid ceilings, so `kill(pid, 0)` is guaranteed ESRCH. */
const NEVER_ALLOCATED_PID = 4_194_304;

describe("readProcessCommand", () => {
    it("reads our own command line", () => {
        const command = readProcessCommand(process.pid);

        expect(command).not.toBeNull();
        expect(command).toContain("bun");
    });

    it("returns null for a dead pid", () => {
        expect(readProcessCommand(NEVER_ALLOCATED_PID)).toBeNull();
    });
});

/** Our own child whose argv holds every byte class `ps` escapes, plus a zombie and a pid that already exited. */
async function startOddProcesses(): Promise<{
    odd: Bun.Subprocess;
    holder: Bun.Subprocess;
    zombie: number;
    exited: number;
}> {
    const script = "sleep 30; : 'nl\nTAB\tbs\\ ctl\x01\x1b del\x7f č'";
    const quiet = { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const;
    const odd = Bun.spawn(["/bin/sh", "-c", script, "zero", "two  spaces", ""], quiet);
    const holder = Bun.spawn(["/bin/sh", "-c", "/bin/sleep 0 & echo $!; exec /bin/sleep 30"], {
        ...quiet,
        stdout: "pipe",
    });
    const { value } = await holder.stdout.getReader().read();
    const zombie = Number(new TextDecoder().decode(value).trim());
    const done = Bun.spawn(["/usr/bin/true"], quiet);
    await done.exited;
    const deadline = Date.now() + 5_000;

    // `ps -o stat=` is the only portable zombie probe; wait until `sleep 0` is one.
    while (
        !Bun.spawnSync(["ps", "-o", "stat=", "-p", String(zombie)], { env: process.env })
            .stdout.toString()
            .includes("Z")
    ) {
        if (Date.now() > deadline) {
            throw new Error(`pid ${zombie} did not become a zombie within 5 s`);
        }

        await Bun.sleep(20);
    }

    return { odd, holder, zombie, exited: done.pid };
}

describe.skipIf(process.platform !== "darwin")("readProcessCommand reads what ps -o command= prints", () => {
    it("escapes newline and tab as octal and other controls as ^X, keeps UTF-8, spacing and backslashes", async () => {
        const started = Date.now();
        const { odd, holder, zombie, exited } = await startOddProcesses();

        try {
            expect(readProcessCommand(odd.pid)).toBe(
                "/bin/sh -c sleep 30; : 'nl\\012TAB\\011bs\\ ctl^A^[ del^? č' zero two  spaces"
            );
            expect(readProcessCommand(zombie)).toBe("<defunct>");
            expect(readProcessCommand(exited)).toBeNull();
            // launchd is root's: answered all the same, as `ps` (setuid root) answers it.
            expect(readProcessCommand(1)).toBe("/sbin/launchd");
            expect(Math.abs((processStartMs(odd.pid) ?? 0) - started)).toBeLessThan(START_MS_TOLERANCE);
            expect(processStartMs(exited)).toBeNull();
            expect(processStartMs(1) ?? Number.NaN).toBeLessThan(started - process.uptime() * 1000);
        } finally {
            odd.kill();
            holder.kill();
            await Promise.all([odd.exited, holder.exited]);
        }
    });

    it("answers our own processes from the kernel, without spawning ps", async () => {
        const child = Bun.spawn(["/bin/sleep", "30"], {
            env: process.env,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        const spawnSync = spyOn(Bun, "spawnSync");

        try {
            expect(readProcessCommand(child.pid)).toBe("/bin/sleep 30");
            expect(processStartMs(child.pid)).not.toBeNull();
            expect(readProcessCommand(NEVER_ALLOCATED_PID)).toBeNull();
            expect(spawnSync.mock.calls.length).toBe(0);
        } finally {
            spawnSync.mockRestore();
            child.kill();
            await child.exited;
        }
    });
});

describe("classifyPid", () => {
    it("reports dead for a never-allocated pid", () => {
        expect(classifyPid(NEVER_ALLOCATED_PID, "anything")).toEqual({
            status: "dead",
            pid: NEVER_ALLOCATED_PID,
        });
    });

    it("reports unverified when no expectation was recorded", () => {
        expect(classifyPid(process.pid)).toEqual({ status: "unverified", pid: process.pid });
    });

    it("reports live when the recorded command matches exactly", () => {
        const command = readProcessCommand(process.pid);

        if (command === null) {
            // Windows / no-ps environment: classifyPid degrades to unverified.
            expect(classifyPid(process.pid, "whatever").status).toBe("unverified");
            return;
        }

        expect(classifyPid(process.pid, command).status).toBe("live");
    });

    it("reports foreign when the recorded command mismatches (pid reuse)", () => {
        const state = classifyPid(process.pid, "/usr/bin/definitely-not-this-process --serve");

        expect(state.status).toBe("foreign");
        expect(state.command).toBeDefined();
    });

    it("supports predicate expectations", () => {
        expect(classifyPid(process.pid, (command) => command.includes("bun")).status).toBe("live");
        expect(classifyPid(process.pid, () => false).status).toBe("foreign");
    });

    it("reports dead for invalid pids", () => {
        expect(classifyPid(0).status).toBe("dead");
        expect(classifyPid(-5).status).toBe("dead");
    });
});

describe("own-pid lookups are read once per process", () => {
    // Regression for the spawn storm behind CI run 35003930205: `buildPidRecord()` asked `ps`
    // for the current process's command AND start time on every lock acquire, 143 spawns per
    // run of src/scripts/lib/journal.test.ts. Both values are constants for the process
    // lifetime. The spy sits on the primitive that spends the resource, and the foreign-pid
    // arm is the negative control proving the spy sees spawns and the cache is own-pid only.
    it("readProcessCommand and processStartMs spawn `ps` at most once for process.pid", () => {
        const spawnSync = spyOn(Bun, "spawnSync");

        try {
            readProcessCommand(process.pid);
            processStartMs(process.pid);
            const warm = spawnSync.mock.calls.length;

            for (let i = 0; i < 10; i++) {
                expect(readProcessCommand(process.pid)).not.toBeNull();
                expect(processStartMs(process.pid)).not.toBeNull();
            }

            expect(spawnSync.mock.calls.length).toBe(warm);

            // Negative control: a live pid that is not ours is still looked up every time. launchd is root's, so
            // on macOS its argv comes from `ps` (setuid root) rather than the kernel read, as on every other system.
            const before = spawnSync.mock.calls.length;
            readProcessCommand(1);
            readProcessCommand(1);
            expect(spawnSync.mock.calls.length).toBe(before + 2);
        } finally {
            spawnSync.mockRestore();
        }
    });
});
