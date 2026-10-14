import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listProcesses, readProcess } from "@genesiscz/utils/process/processes";
import { formatLstart, listProcessBasics, readProcessBasics } from "./process-basics";

const REPO = join(import.meta.dir, "..", "..", "..");

test("the plugin's copy is byte-identical to the one in src/utils/process", () => {
    const canonical = readFileSync(join(REPO, "src/utils/process/process-basics.ts"), "utf8");
    const copy = readFileSync(join(import.meta.dir, "process-basics.ts"), "utf8");
    // Edit src/utils/process/process-basics.ts, then copy it over plugins/genesis-tools/lib/process-basics.ts.
    expect(copy === canonical).toBe(true);
});

// The standalone reader must answer exactly what the utils layer answers, for the processes a hook reads: itself,
// its parent (the agent), and a long-lived root process.
describe.skipIf(process.platform === "win32")("readProcessBasics", () => {
    test("matches readProcess for this process, its parent and pid 1", () => {
        for (const pid of [process.pid, process.ppid, 1]) {
            const basics = readProcessBasics(pid);
            const utils = readProcess(pid, { otherUsers: true });

            expect(basics).not.toBeNull();
            expect({ ...basics, startMs: undefined }).toEqual({
                pid,
                ppid: utils?.ppid,
                name: utils?.name,
                command: utils?.command,
                tty: utils?.tty,
                startMs: undefined,
            });
            // Linux reads start time in 10 ms ticks; macOS in microseconds.
            expect(Math.abs((basics?.startMs ?? 0) - (utils?.startMs ?? 0))).toBeLessThan(20);
        }
    });

    test("reads this user's processes without starting ps", () => {
        const spawnSync = spyOn(Bun, "spawnSync");
        let calls: unknown[][] = [];

        try {
            readProcessBasics(process.pid);
            readProcessBasics(process.ppid);
            listProcessBasics();
        } finally {
            // Copied before the restore: `mockRestore()` clears `mock.calls`.
            calls = [...spawnSync.mock.calls];
            spawnSync.mockRestore();
        }

        expect(calls).toEqual([]);
    });

    test("the table agrees with the utils layer on parents and start times", () => {
        const utils = new Map(listProcesses({ commands: false }).map((entry) => [entry.pid, entry]));
        const table = listProcessBasics();
        const common = table.filter((row) => utils.has(row.pid));

        // Processes start and end between the two reads; the survivors must agree.
        expect(common.length).toBeGreaterThan(table.length * 0.9);
        expect(common.filter((row) => utils.get(row.pid)?.ppid !== row.ppid)).toEqual([]);
        expect(table.find((row) => row.pid === process.pid)?.ppid).toBe(process.ppid);
    });

    test("the start time prints as ps -o lstart= does, in ps's time zone", () => {
        const fromPs = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.ppid)], { env: process.env })
            .stdout.toString()
            .trim();
        expect(formatLstart(readProcessBasics(process.ppid)?.startMs ?? 0)).toBe(fromPs);
    });

    test("a pid that does not exist, and nonsense input", () => {
        expect(readProcessBasics(2 ** 22 + 17)).toBeNull();
        expect(readProcessBasics(0)).toBeNull();
        expect(readProcessBasics(-5)).toBeNull();
        expect(readProcessBasics(1.5)).toBeNull();
    });
});
