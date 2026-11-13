// One racer of claim-takeover.test.ts in its own process: a takeover must hold across processes, which promises in one
// test process cannot show, because the takeover runs as one synchronous section there.
// argv: <mode> <path> <start at, epoch ms> [<run ms>]
//   lock         tryAcquireLock until it wins or <run ms> runs out; prints {"won":bool}, then keeps a won lock (stays alive) until killed
//   sweep        sweepStaleLocks on the path's folder once; prints {"reaped":n}
//   slow-writer  opens the path with wx, prints "open", writes its record after <run ms>, prints "written", stays alive
//   sweep-loop   sweeps the path's folder until <run ms> has passed; prints {"reaped":n}
//   churn        until <run ms> has passed: leaves a dead holder, waits for a sweeper to reap it, claims the path
//                fresh, and checks that its live claim was not deleted; prints {"cycles":n,"lost":n}
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { buildPidRecord, serializePidRecord } from "@genesiscz/utils/process/pidfile";
import { tryAcquireLock } from "@genesiscz/utils/storage/file-lock";
import { sweepStaleLocks } from "@genesiscz/utils/storage/stale-lock-sweep";

const DEAD_PID = 999999999;
/** A killed parent must not leave a racer behind. */
const SELF_DEADLINE_MS = 30_000;

const [mode, path, startAt, runMsArg] = process.argv.slice(2);

if (!mode || !path || !startAt) {
    throw new Error("usage: claim-takeover.test-worker.ts <mode> <path> <start at> [<run ms>]");
}

const runMs = Number(runMsArg ?? "0");
setTimeout(() => process.exit(3), SELF_DEADLINE_MS).unref();

function print(value: unknown): void {
    process.stdout.write(`${typeof value === "string" ? value : SafeJSON.stringify(value, { strict: true })}\n`);
}

async function stayAlive(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, SELF_DEADLINE_MS));
}

function hasCode(err: unknown, code: string): boolean {
    return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

// Every racer starts at the same moment: process starts are spread over hundreds of milliseconds.
await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));

if (mode === "lock") {
    // Like withFileLock: a racer that did not get the lock tries again until its budget runs out. A winner never
    // releases, so a second winner would be a broken lock.
    const giveUpAt = Date.now() + runMs;
    let won = await tryAcquireLock(path);

    while (!won && Date.now() < giveUpAt) {
        await Bun.sleep(Math.min(50, Math.max(0, giveUpAt - Date.now())));
        won = await tryAcquireLock(path);
    }

    print({ won });
    await stayAlive();
} else if (mode === "sweep") {
    print({ reaped: sweepStaleLocks(dirname(path)).reaped.length });
} else if (mode === "slow-writer") {
    const fd = openSync(path, "wx");
    print("open");
    await Bun.sleep(runMs);
    writeSync(fd, serializePidRecord(buildPidRecord()));
    closeSync(fd);
    print("written");
    await stayAlive();
} else if (mode === "sweep-loop") {
    const until = Date.now() + runMs;
    let reaped = 0;

    while (Date.now() < until) {
        reaped += sweepStaleLocks(dirname(path)).reaped.length;
        await Bun.sleep(1);
    }

    print({ reaped });
} else if (mode === "churn") {
    const until = Date.now() + runMs;
    const dead = SafeJSON.stringify({ pid: DEAD_PID, command: "gone", writtenAt: 1 });
    const mine = serializePidRecord(buildPidRecord());
    let cycles = 0;
    let lost = 0;

    while (Date.now() < until) {
        try {
            writeFileSync(path, dead, { flag: "wx" });
        } catch (err) {
            if (!hasCode(err, "EEXIST")) {
                throw err;
            }
        }

        // A sweeper reaps the dead holder; then this process claims the path as a fresh login would, retrying at once
        // so the claim lands right behind the reap, where a sweeper that judged an older read would delete it.
        const reapBy = Date.now() + 2_000;
        let claimed = false;

        while (!claimed && Date.now() < reapBy) {
            try {
                writeFileSync(path, mine, { flag: "wx" });
                claimed = true;
            } catch (err) {
                if (!hasCode(err, "EEXIST")) {
                    throw err;
                }
            }
        }

        if (!claimed) {
            break;
        }

        // Hold the live claim while the sweepers keep going, then check that nobody deleted it.
        await Bun.sleep(3);
        let still: string | null = null;

        try {
            still = readFileSync(path, "utf-8");
        } catch (err) {
            if (!hasCode(err, "ENOENT")) {
                throw err;
            }
        }

        if (still === mine) {
            unlinkSync(path);
        } else {
            lost += 1;
        }

        cycles += 1;
    }

    print({ cycles, lost });
} else {
    throw new Error(`unknown mode ${mode}`);
}

process.exit(0);
