// One suite for every takeover of a claim file: the shared `takeOverStaleClaim` in pidfile.ts and its callers
// (`tryAcquireLock` in file-lock.ts, `claimPidFile`, the login slot sweep). These locks guard config writes, so each
// race case asserts exactly one winner and that no live claim is ever deleted.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { tryWithPathArbitration } from "@genesiscz/utils/process/path-arbitration";
import { tryAcquireLock } from "@genesiscz/utils/storage/file-lock";
import { sweepStaleLocks } from "@genesiscz/utils/storage/stale-lock-sweep";
import {
    attemptStaleTakeover,
    buildPidRecord,
    claimPidFile,
    EMPTY_HOLDER_GRACE_MS,
    parsePidRecord,
    readPidRecord,
    serializePidRecord,
    takeOverStaleClaim,
    takeOverStaleClaimAsync,
} from "./pidfile";

/** A pid the kernel will never have handed out: the "owner is gone" case. */
const DEAD_PID = 999999999;
const WORKER = join(import.meta.dir, "claim-takeover.test-worker.ts");
const RACERS = 12;

const deadRecord = SafeJSON.stringify({ pid: DEAD_PID, command: "gone", writtenAt: 1 });
const isGone = () => true;

let dir: string;
let path: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claim-takeover-test-"));
    path = join(dir, "target.lock");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Files in the folder, without the arbiter's own lock folder (`<path>.claim-arbitration.lock`). */
function claimFiles(): string[] {
    return readdirSync(dir)
        .filter((name) => !name.endsWith(".claim-arbitration.lock"))
        .sort();
}

function backdate(file: string, ms: number): void {
    const then = new Date(Date.now() - ms);
    utimesSync(file, then, then);
}

/** Holds the path's arbiter as another claimer inside its takeover would, until `release` is called. */
async function holdArbiter(target: string): Promise<{ release: () => Promise<void> }> {
    let release: () => void = () => {};
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
        ready = resolve;
    });
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const owner = tryWithPathArbitration(target, async () => {
        ready();
        await held;
    });
    await started;

    return {
        release: async () => {
            release();
            expect((await owner).acquired).toBe(true);
        },
    };
}

interface Racer {
    child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    lines: AsyncIterator<string>;
}

function spawnRacer(args: string[]): Racer {
    const child = Bun.spawn([process.execPath, WORKER, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
    });
    return { child, lines: readLines(child.stdout) };
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");

        while (newline >= 0) {
            yield buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
        }
    }
}

async function nextLine(racer: Racer): Promise<string> {
    const next = await racer.lines.next();

    if (next.done) {
        const code = await racer.child.exited;
        throw new Error(`racer exited ${code} before answering: ${await new Response(racer.child.stderr).text()}`);
    }

    return next.value;
}

async function stopAll(racers: Racer[]): Promise<void> {
    for (const racer of racers) {
        racer.child.kill();
    }

    await Promise.all(racers.map((racer) => racer.child.exited));
}

describe("takeOverStaleClaim", () => {
    test("exactly one of N in-process racers takes a dead claim, and the slot is left empty for the winner's create", async () => {
        writeFileSync(path, deadRecord);

        const outcomes = await Promise.all(
            Array.from({ length: RACERS }, (_, i) =>
                i % 2 === 0
                    ? takeOverStaleClaimAsync(path, { arbiter: path, holderIsStale: isGone })
                    : Promise.resolve(takeOverStaleClaim(path, { arbiter: path, holderIsStale: isGone }))
            )
        );

        expect(outcomes.filter((outcome) => outcome === "taken")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome !== "taken").every((outcome) => outcome === "lost-race")).toBe(
            true
        );
        expect(claimFiles()).toEqual([]);
    });

    test("a live holder is held and its bytes are untouched; the verdict sees the exact bytes it judges", () => {
        const live = serializePidRecord(buildPidRecord());
        writeFileSync(path, live);
        const seen: string[] = [];

        expect(
            takeOverStaleClaim(path, {
                arbiter: path,
                holderIsStale: (holder, raw) => {
                    seen.push(raw);
                    return holder.pid !== process.pid;
                },
            })
        ).toBe("held");
        expect(seen).toEqual([live]);
        expect(readFileSync(path, "utf-8")).toBe(live);
        expect(takeOverStaleClaim(join(dir, "missing.lock"), { arbiter: path, holderIsStale: isGone })).toBe(
            "lost-race"
        );
    });

    test("an empty holder is held inside the grace for every caller, and one orphaned past it is taken by exactly one racer", async () => {
        writeFileSync(path, "");
        let asked = 0;
        const never = () => {
            asked += 1;
            return false;
        };

        expect(takeOverStaleClaim(path, { arbiter: path, holderIsStale: isGone })).toBe("held");
        expect(await tryAcquireLock(path)).toBe(false);
        expect(sweepStaleLocks(dir).reaped).toEqual([]);
        expect(readFileSync(path, "utf-8")).toBe("");

        backdate(path, EMPTY_HOLDER_GRACE_MS + 1_000);
        const outcomes = Array.from({ length: RACERS }, () =>
            takeOverStaleClaim(path, { arbiter: path, holderIsStale: never })
        );

        // A caller that never takes a holder over (the start gate) is not asked about a file that names no one.
        expect(outcomes.filter((outcome) => outcome === "taken")).toHaveLength(1);
        expect(asked).toBe(0);
        expect(claimFiles()).toEqual([]);
    });

    test("a pid recycled onto this process from another program is stale, and the sweep says so", () => {
        writeFileSync(
            path,
            serializePidRecord({
                pid: process.pid,
                command: "/usr/bin/definitely-not-this-process --serve",
                startedAt: Date.now() - 600_000,
                writtenAt: 1,
            })
        );

        expect(sweepStaleLocks(dir).reaped).toMatchObject([{ lock: path, pid: process.pid, reason: "recycled_pid" }]);
        expect(existsSync(path)).toBe(false);
    });

    test("nothing is removed while another claimer holds the arbiter", async () => {
        writeFileSync(path, deadRecord);
        const other = await holdArbiter(path);

        try {
            expect(takeOverStaleClaim(path, { arbiter: path, holderIsStale: isGone })).toBe("lost-race");
            expect(await takeOverStaleClaimAsync(path, { arbiter: path, holderIsStale: isGone, waitMs: 60 })).toBe(
                "lost-race"
            );
            expect(await attemptStaleTakeover(path, deadRecord, { claim: false })).toBe(false);
            expect(await tryAcquireLock(path)).toBe(false);
            expect(sweepStaleLocks(dir).reaped).toEqual([]);
            expect(readFileSync(path, "utf-8")).toBe(deadRecord);
        } finally {
            await other.release();
        }

        expect(sweepStaleLocks(dir).reaped).toMatchObject([{ lock: path, pid: DEAD_PID, reason: "dead_pid" }]);
    });

    test("a removal that finds bytes other than the validated ones restores them and loses", async () => {
        writeFileSync(path, "12345");

        expect(await attemptStaleTakeover(path, String(DEAD_PID))).toBe(false);
        expect(readFileSync(path, "utf-8")).toBe("12345");
        expect(claimFiles()).toEqual(["target.lock"]);
    });
});

describe("callers of the takeover", () => {
    test("exactly one of N in-process tryAcquireLock racers wins a dead lock, and the lock names it", async () => {
        writeFileSync(path, String(DEAD_PID));

        const results = await Promise.all(Array.from({ length: RACERS }, () => tryAcquireLock(path)));

        expect(results.filter(Boolean)).toHaveLength(1);
        const held = parsePidRecord(readFileSync(path, "utf-8"));
        expect(held?.pid).toBe(process.pid);
        expect(held?.command ?? "").toContain("bun");
        expect(claimFiles()).toEqual(["target.lock"]);
    });

    test("claimPidFile and tryAcquireLock racing for one dead claim produce exactly one owner", async () => {
        writeFileSync(path, deadRecord);
        // Every racer here is this one process, so the claim keeps holders of this pid (its default takes them over).
        const reclaimable = (state: { status: string }) => state.status === "dead" || state.status === "foreign";

        const results = await Promise.all(
            Array.from({ length: RACERS }, (_, i) =>
                i % 2 === 0
                    ? tryAcquireLock(path)
                    : claimPidFile(path, { reclaimable }).then((claim) => claim.status === "claimed")
            )
        );

        expect(results.filter(Boolean)).toHaveLength(1);
        expect(readPidRecord(path)?.pid).toBe(process.pid);
    });

    test("a caller rule that keeps dead and recycled holders only still takes an orphaned empty file (meetings watch)", async () => {
        const onlyStale = (state: { status: string }) => state.status === "dead" || state.status === "foreign";
        writeFileSync(path, "");

        expect(await claimPidFile(path, { reclaimable: onlyStale })).toEqual({
            status: "held",
            state: { status: "none" },
        });

        backdate(path, EMPTY_HOLDER_GRACE_MS + 1_000);
        expect(await claimPidFile(path, { reclaimable: onlyStale })).toEqual({ status: "claimed", tookOver: true });
        expect(readPidRecord(path)?.pid).toBe(process.pid);
    });

    test("the sweep reaps a dead login slot with its whole payload, and leaves a live one", () => {
        const slot = join(dir, "agent-1.login");
        const payload = { pid: DEAD_PID, since: "2026-01-01T00:00:00.000Z", owner: "agent-1", kind: "login" };
        writeFileSync(slot, SafeJSON.stringify(payload), { flag: "wx" });

        expect(sweepStaleLocks(dir).reaped).toMatchObject([
            { lock: slot, pid: DEAD_PID, reason: "dead_pid", payload: { owner: "agent-1", kind: "login" } },
        ]);

        writeFileSync(slot, SafeJSON.stringify({ ...payload, pid: process.pid }), { flag: "wx" });
        expect(sweepStaleLocks(dir)).toMatchObject({ reaped: [], inspected: 1 });
        expect(existsSync(slot)).toBe(true);
    });
});

describe("racers in separate processes", () => {
    test("exactly one of N lock racers wins a dead lock across processes while sweepers run, and the winner keeps it", async () => {
        writeFileSync(path, deadRecord);
        const startAt = String(Date.now() + 1_500);
        const lockers = Array.from({ length: 4 }, () => spawnRacer(["lock", path, startAt, "1000"]));
        const sweepers = Array.from({ length: 2 }, () => spawnRacer(["sweep", path, startAt]));

        try {
            const answers = await Promise.all(
                lockers.map(async (racer) => ({
                    pid: racer.child.pid,
                    ...(SafeJSON.parse(await nextLine(racer), { strict: true }) as { won: boolean }),
                }))
            );
            await Promise.all(sweepers.map((racer) => nextLine(racer)));

            const winners = answers.filter((answer) => answer.won);
            expect(winners).toHaveLength(1);
            // Every racer has answered and the winner is still alive: the lock must still name it.
            expect(readPidRecord(path)?.pid).toBe(winners[0]?.pid);
        } finally {
            await stopAll([...lockers, ...sweepers]);
        }
    }, 30_000);

    test("a slow writer between its wx create and its write keeps its claim against every racer", async () => {
        const writer = spawnRacer(["slow-writer", path, String(Date.now()), "300"]);

        try {
            expect(await nextLine(writer)).toBe("open");

            const during = await Promise.all([
                ...Array.from({ length: 4 }, () =>
                    takeOverStaleClaimAsync(path, { arbiter: path, holderIsStale: isGone })
                ),
                ...Array.from({ length: 4 }, () => tryAcquireLock(path).then((won) => (won ? "taken" : "held"))),
                claimPidFile(path).then((claim) => claim.status),
                Promise.resolve(sweepStaleLocks(dir).reaped.length === 0 ? "held" : "taken"),
            ]);
            expect(during.filter((outcome) => outcome === "taken" || outcome === "claimed")).toEqual([]);

            expect(await nextLine(writer)).toBe("written");
            expect(readPidRecord(path)?.pid).toBe(writer.child.pid);
            expect(await tryAcquireLock(path)).toBe(false);
            expect(sweepStaleLocks(dir).reaped).toEqual([]);
            expect(readPidRecord(path)?.pid).toBe(writer.child.pid);
        } finally {
            await stopAll([writer]);
        }

        // Once the writer is gone its claim is stale, and exactly one racer takes it.
        const after = await Promise.all(Array.from({ length: RACERS }, () => tryAcquireLock(path)));
        expect(after.filter(Boolean)).toHaveLength(1);
    }, 30_000);

    test("sweepers reaping while a login reclaims the path never delete the fresh claim", async () => {
        const startAt = String(Date.now() + 1_500);
        const churnMs = "1500";
        const claimer = spawnRacer(["churn", path, startAt, churnMs]);
        const sweepers = Array.from({ length: 3 }, () => spawnRacer(["sweep-loop", path, startAt, churnMs]));

        try {
            const churn = SafeJSON.parse(await nextLine(claimer), { strict: true }) as { cycles: number; lost: number };
            await Promise.all(sweepers.map((racer) => nextLine(racer)));

            expect(churn.cycles).toBeGreaterThan(10);
            expect(churn.lost).toBe(0);
        } finally {
            await stopAll([claimer, ...sweepers]);
        }
    }, 30_000);
});
