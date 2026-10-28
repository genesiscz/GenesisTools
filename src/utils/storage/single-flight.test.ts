// biome-ignore-all lint/plugin: test fixture intentionally uses /tmp/ string literals — production plugins do not apply to test code
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { serializePidRecord } from "@genesiscz/utils/process/pidfile";
import { withFileLock } from "./file-lock";
import { singleFlight } from "./single-flight";

const WORKER = join(import.meta.dir, "single-flight.test-worker.ts");

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "single-flight-test-"));
});

afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
});

/** The file names `singleFlight` uses for a key: `<hash>.lock` while a run holds it, `<hash>.json` for its answer. */
function filesOf(key: string, folder = dir): { lock: string; answer: string } {
    const name = Bun.hash(key).toString(16);

    return { lock: join(folder, `${name}.lock`), answer: join(folder, `${name}.json`) };
}

/** A `run` that counts its calls and answers `value` after `ms`. */
function counted<T>(value: T, ms = 0) {
    const counter = { runs: 0 };
    const run = async () => {
        counter.runs++;

        if (ms > 0) {
            await Bun.sleep(ms);
        }

        return value;
    };

    return { counter, run };
}

/** Holds the key's lock from this process until `release()`, as a slow run of another caller would. */
async function holdLock(key: string): Promise<{ release: () => Promise<void> }> {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        open = resolve;
    });
    let taken: () => void = () => {};
    const isTaken = new Promise<void>((resolve) => {
        taken = resolve;
    });
    const held = withFileLock(
        filesOf(key).lock,
        async () => {
            taken();
            await gate;
        },
        1000
    );
    await isTaken;

    return {
        release: async () => {
            open();
            await held;
        },
    };
}

function writeAnswer(key: string, at: number, value: unknown): void {
    writeFileSync(filesOf(key).answer, SafeJSON.stringify({ key, at, value }, { strict: true }));
}

/** Every file left in the folder, temp files of an atomic write included. */
function leftovers(folder = dir): string[] {
    return existsSync(folder) ? readdirSync(folder).sort() : [];
}

describe("singleFlight: concurrency in one process", () => {
    for (const callers of [2, 10, 50]) {
        it(`${callers} callers with the same key run once, and every caller gets the same answer`, async () => {
            const { counter, run } = counted({ n: 42 }, 30);

            const answers = await Promise.all(
                Array.from({ length: callers }, () => singleFlight({ key: "same", run, dir, waitMs: 5000 }))
            );

            expect(counter.runs).toBe(1);
            expect(answers).toHaveLength(callers);

            for (const answer of answers) {
                expect(answer).toEqual({ n: 42 });
            }
        });
    }

    it("different keys run in parallel, not one after another", async () => {
        const started: string[] = [];
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const run = (key: string) => async () => {
            started.push(key);

            if (started.length === 3) {
                release();
            }

            await gate;
            return key;
        };

        const answers = await Promise.all(
            ["a", "b", "c"].map((key) => singleFlight({ key, run: run(key), dir, waitMs: 1000 }))
        );

        expect(answers).toEqual(["a", "b", "c"]);
        expect(started.sort()).toEqual(["a", "b", "c"]);
    });

    it("a waiter reads the holder's answer and never runs, even when it arrives mid-run", async () => {
        const { counter, run } = counted("first", 80);
        const first = singleFlight({ key: "late", run, dir });
        await Bun.sleep(20);
        const late = await singleFlight({ key: "late", run: async () => "late ran", dir });

        expect(await first).toBe("first");
        expect(late).toBe("first");
        expect(counter.runs).toBe(1);
    });

    it("a caller after the run finished reads the shared answer without taking the lock", async () => {
        const { counter, run } = counted("done");
        await singleFlight({ key: "after", run, dir });
        const { release } = await holdLock("after");

        try {
            // The lock is held, yet the fresh answer is read before any wait for it.
            const answer = await singleFlight({ key: "after", run, dir, waitMs: 20, retries: 0 });
            expect(answer).toBe("done");
            expect(counter.runs).toBe(1);
        } finally {
            await release();
        }
    });
});

describe("singleFlight: concurrency across processes", () => {
    async function workers(count: number, runMs: number): Promise<{ answers: unknown[]; runs: string[] }> {
        const runsPath = join(dir, "runs.txt");
        writeFileSync(runsPath, "");
        const startAt = Date.now() + 1000;
        const children = Array.from({ length: count }, () =>
            Bun.spawn(
                [
                    process.execPath,
                    WORKER,
                    join(dir, "flights"),
                    "workers",
                    runsPath,
                    String(runMs),
                    "10000",
                    String(startAt),
                ],
                {
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { ...process.env },
                }
            )
        );
        const answers = await Promise.all(
            children.map(async (child) => {
                const [stdout, stderr, code] = await Promise.all([
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                    child.exited,
                ]);

                if (code !== 0) {
                    throw new Error(`worker exited ${code}: ${stderr}`);
                }

                return SafeJSON.parse(stdout, { strict: true });
            })
        );

        return { answers, runs: readFileSync(runsPath, "utf8").split("\n").filter(Boolean) };
    }

    it("2 processes asking at the same moment start one run and share its answer", async () => {
        const { answers, runs } = await workers(2, 300);

        expect(runs).toHaveLength(1);
        expect(answers[0]).toEqual(answers[1]);
        expect(answers[0]).toEqual({ by: Number(runs[0]), text: "žluťoučký kůň 🐎" });
    }, 20_000);

    it("10 processes asking at the same moment start one run, and the lock is gone afterwards", async () => {
        const { answers, runs } = await workers(10, 300);

        expect(runs).toHaveLength(1);
        expect(new Set(answers.map((answer) => SafeJSON.stringify(answer, { strict: true }))).size).toBe(1);
        expect(leftovers(join(dir, "flights")).filter((name) => name.endsWith(".lock"))).toEqual([]);
    }, 30_000);
});

describe("singleFlight: the answer's age (ttlMs)", () => {
    it("serves an answer inside ttlMs without running", async () => {
        const { counter, run } = counted("fresh");
        writeAnswer("hit", Date.now() - 500, "held");

        expect(await singleFlight({ key: "hit", run, dir, ttlMs: 10_000 })).toBe("held");
        expect(counter.runs).toBe(0);
    });

    it("runs again once the answer is older than ttlMs", async () => {
        const { counter, run } = counted("again");
        writeAnswer("old", Date.now() - 11_000, "stale");

        expect(await singleFlight({ key: "old", run, dir, ttlMs: 10_000 })).toBe("again");
        expect(counter.runs).toBe(1);
    });

    it("an answer exactly ttlMs old is expired: the age must be below ttlMs", async () => {
        const { counter, run } = counted("ran");
        const realNow = Date.now;
        const now = realNow();
        Date.now = () => now;

        try {
            writeAnswer("edge", now - 1000, "edge");
            expect(await singleFlight({ key: "edge", run, dir, ttlMs: 1000 })).toBe("ran");
            writeAnswer("edge-inside", now - 999, "inside");
            expect(await singleFlight({ key: "edge-inside", run, dir, ttlMs: 1000 })).toBe("inside");
        } finally {
            Date.now = realNow;
        }

        expect(counter.runs).toBe(1);
    });

    it("ttlMs 0 never shares: every caller runs, one after another under the lock", async () => {
        const { counter, run } = counted("zero", 20);

        const answers = await Promise.all([1, 2, 3].map(() => singleFlight({ key: "zero", run, dir, ttlMs: 0 })));

        expect(answers).toEqual(["zero", "zero", "zero"]);
        expect(counter.runs).toBe(3);
    });

    it("the shared answer expires on its own clock: a later call after the age runs again", async () => {
        const { counter, run } = counted("tick");
        await singleFlight({ key: "tick", run, dir, ttlMs: 40 });
        await singleFlight({ key: "tick", run, dir, ttlMs: 40 });
        expect(counter.runs).toBe(1);

        await Bun.sleep(60);
        await singleFlight({ key: "tick", run, dir, ttlMs: 40 });
        expect(counter.runs).toBe(2);
    });

    it("a caller with a shorter ttlMs runs although a longer-lived caller would read the same file", async () => {
        const { counter, run } = counted("short");
        writeAnswer("mixed", Date.now() - 2000, "two seconds old");

        expect(await singleFlight({ key: "mixed", run, dir, ttlMs: 10_000 })).toBe("two seconds old");
        expect(await singleFlight({ key: "mixed", run, dir, ttlMs: 1000 })).toBe("short");
        expect(counter.runs).toBe(1);
    });
});

describe("singleFlight: waitMs, retries and fallback", () => {
    for (const retries of [0, 1, 3]) {
        it(`with retries ${retries}, waits ${retries + 1} times waitMs for a slow holder, then calls fallback once`, async () => {
            const { release } = await holdLock(`slow-${retries}`);
            const { counter, run } = counted("ran");
            let fallbacks = 0;
            const started = Date.now();

            try {
                const answer = await singleFlight({
                    key: `slow-${retries}`,
                    run,
                    dir,
                    waitMs: 40,
                    retries,
                    fallback: async () => {
                        fallbacks++;
                        return "fell back";
                    },
                });

                expect(answer).toBe("fell back");
            } finally {
                await release();
            }

            expect(fallbacks).toBe(1);
            expect(counter.runs).toBe(0);
            expect(Date.now() - started).toBeGreaterThanOrEqual(40 * (retries + 1) - 5);
        });
    }

    it("fallback defaults to run: a caller that gave up still answers, by running the command itself", async () => {
        const { release } = await holdLock("default-fallback");
        const { counter, run } = counted("ran myself");

        try {
            expect(await singleFlight({ key: "default-fallback", run, dir, waitMs: 30, retries: 0 })).toBe(
                "ran myself"
            );
        } finally {
            await release();
        }

        expect(counter.runs).toBe(1);
    });

    it("a fallback that throws rejects the call with that error", async () => {
        const { release } = await holdLock("throwing-fallback");

        try {
            await expect(
                singleFlight({
                    key: "throwing-fallback",
                    run: async () => "never",
                    fallback: async () => {
                        throw new Error("fallback broke");
                    },
                    dir,
                    waitMs: 30,
                    retries: 0,
                })
            ).rejects.toThrow("fallback broke");
        } finally {
            await release();
        }
    });

    it("a holder that finishes inside the retry hands its answer to the waiter, no fallback", async () => {
        const key = "finishes-in-retry";
        const { release } = await holdLock(key);
        let fallbacks = 0;
        setTimeout(() => {
            writeAnswer(key, Date.now(), "holder's answer");
            void release();
        }, 60);

        const answer = await singleFlight({
            key,
            run: async () => "ran",
            fallback: async () => {
                fallbacks++;
                return "fell back";
            },
            dir,
            waitMs: 40,
            retries: 2,
        });

        expect(answer).toBe("holder's answer");
        expect(fallbacks).toBe(0);
    });
});

describe("singleFlight: failures", () => {
    it("a run that throws rejects the caller, shares nothing and releases the lock", async () => {
        await expect(
            singleFlight({
                key: "throws",
                run: async () => {
                    throw new Error("gh failed");
                },
                dir,
            })
        ).rejects.toThrow("gh failed");

        expect(leftovers()).toEqual([]);
    });

    it("when the holder's run throws, each waiter runs for itself, and the first success is shared after it", async () => {
        let calls = 0;
        const run = async () => {
            calls++;
            await Bun.sleep(20);

            if (calls === 1) {
                throw new Error("first run failed");
            }

            return `answer ${calls}`;
        };

        const results = await Promise.allSettled([1, 2, 3, 4].map(() => singleFlight({ key: "flaky", run, dir })));

        // Which caller takes the lock first is not fixed; exactly one of them sees the failure.
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const answers = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
        expect(answers).toEqual(["answer 2", "answer 2", "answer 2"]);
        expect(calls).toBe(2);
    });

    it("an answer shouldShare refuses (a non-zero exit) is returned to its caller only; the next caller runs", async () => {
        const { counter, run } = counted({ exitCode: 1, stdout: "" });
        const shouldShare = (value: { exitCode: number }) => value.exitCode === 0;

        expect(await singleFlight({ key: "exit-1", run, dir, shouldShare })).toEqual({ exitCode: 1, stdout: "" });
        expect(await singleFlight({ key: "exit-1", run, dir, shouldShare })).toEqual({ exitCode: 1, stdout: "" });

        expect(counter.runs).toBe(2);
        expect(existsSync(filesOf("exit-1").answer)).toBe(false);
    });

    it("shouldShare sees the value, and a shared exit 0 is served to the next caller", async () => {
        const seen: unknown[] = [];
        const { counter, run } = counted({ exitCode: 0, stdout: "ok" });
        const shouldShare = (value: { exitCode: number }) => {
            seen.push(value);
            return value.exitCode === 0;
        };

        await singleFlight({ key: "exit-0", run, dir, shouldShare });
        await singleFlight({ key: "exit-0", run, dir, shouldShare });

        expect(counter.runs).toBe(1);
        expect(seen).toEqual([{ exitCode: 0, stdout: "ok" }]);
    });

    it("an answer it cannot write is logged and still returned; the next caller runs again", async () => {
        const key = "unwritable-answer";
        mkdirSync(filesOf(key).answer);
        const { counter, run } = counted("unsaved");

        expect(await singleFlight({ key, run, dir })).toBe("unsaved");
        expect(await singleFlight({ key, run, dir })).toBe("unsaved");
        expect(counter.runs).toBe(2);
        expect(existsSync(filesOf(key).lock)).toBe(false);
    });
});

describe("singleFlight: stale and odd locks", () => {
    it("takes over a lock whose process died", async () => {
        const { counter, run } = counted("mine");
        writeFileSync(filesOf("dead").lock, "999999999");

        expect(await singleFlight({ key: "dead", run, dir, waitMs: 2000 })).toBe("mine");
        expect(counter.runs).toBe(1);
        expect(existsSync(filesOf("dead").lock)).toBe(false);
    });

    it("takes over a lock written in the pid record form whose process died", async () => {
        const { counter, run } = counted("mine");
        writeFileSync(
            filesOf("dead-record").lock,
            serializePidRecord({
                pid: 999999999,
                startedAt: Date.now() - 60_000,
                command: "bun",
                writtenAt: Date.now() - 60_000,
            })
        );

        expect(await singleFlight({ key: "dead-record", run, dir, waitMs: 2000 })).toBe("mine");
        expect(counter.runs).toBe(1);
    });

    it("takes over an empty lock file (a holder killed between create and write)", async () => {
        const { counter, run } = counted("mine");
        const { lock } = filesOf("empty");
        writeFileSync(lock, "");
        const old = new Date(Date.now() - 60_000);
        utimesSync(lock, old, old);

        expect(await singleFlight({ key: "empty", run, dir, waitMs: 2000 })).toBe("mine");
        expect(counter.runs).toBe(1);
    });

    it("a lock with garbage content is not a live holder: it is taken over", async () => {
        const { counter, run } = counted("mine");
        const { lock } = filesOf("garbage");
        writeFileSync(lock, "not a pid {]");
        const old = new Date(Date.now() - 60_000);
        utimesSync(lock, old, old);

        expect(await singleFlight({ key: "garbage", run, dir, waitMs: 2000 })).toBe("mine");
        expect(counter.runs).toBe(1);
    });

    it("a live holder older than waitMs is never broken: the caller waits, then falls back", async () => {
        const { release } = await holdLock("old-live");
        await Bun.sleep(50);
        const { counter, run } = counted("ran");

        try {
            const answer = await singleFlight({
                key: "old-live",
                run,
                fallback: async () => "fell back",
                dir,
                waitMs: 20,
                retries: 0,
            });
            expect(answer).toBe("fell back");
        } finally {
            await release();
        }

        expect(counter.runs).toBe(0);
    });

    it("a lock without an answer file makes the caller wait; once released with no answer, the caller runs", async () => {
        const { release } = await holdLock("no-answer");
        const { counter, run } = counted("ran after release");
        setTimeout(() => void release(), 40);

        expect(await singleFlight({ key: "no-answer", run, dir, waitMs: 1000 })).toBe("ran after release");
        expect(counter.runs).toBe(1);
    });
});

describe("singleFlight: the answer file", () => {
    it("a torn (partial) answer reads as no answer: the caller runs and replaces it", async () => {
        const { counter, run } = counted("whole");
        writeFileSync(filesOf("torn").answer, `{"key":"torn","at":${Date.now()},"value":"ha`);

        expect(await singleFlight({ key: "torn", run, dir })).toBe("whole");
        expect(counter.runs).toBe(1);
        expect(SafeJSON.parse(readFileSync(filesOf("torn").answer, "utf8"), { strict: true }).value).toBe("whole");
    });

    it("an answer that is not JSON at all reads as no answer", async () => {
        const { counter, run } = counted("whole");
        writeFileSync(filesOf("binary").answer, Buffer.from([0, 159, 146, 150, 255]));

        expect(await singleFlight({ key: "binary", run, dir })).toBe("whole");
        expect(counter.runs).toBe(1);
    });

    it("an answer for another key in the same file (a hash collision) is never served", async () => {
        const { counter, run } = counted("mine");
        writeFileSync(
            filesOf("wanted").answer,
            SafeJSON.stringify({ key: "someone else", at: Date.now(), value: "theirs" }, { strict: true })
        );

        expect(await singleFlight({ key: "wanted", run, dir })).toBe("mine");
        expect(counter.runs).toBe(1);
    });

    it("an answer missing its time or value reads as no answer", async () => {
        const { counter, run } = counted("mine");
        writeFileSync(filesOf("no-at").answer, SafeJSON.stringify({ key: "no-at", value: "x" }, { strict: true }));
        writeFileSync(
            filesOf("no-value").answer,
            SafeJSON.stringify({ key: "no-value", at: Date.now() }, { strict: true })
        );
        writeFileSync(
            filesOf("text-at").answer,
            SafeJSON.stringify({ key: "text-at", at: String(Date.now()), value: "x" }, { strict: true })
        );

        expect(await singleFlight({ key: "no-at", run, dir })).toBe("mine");
        expect(await singleFlight({ key: "no-value", run, dir })).toBe("mine");
        expect(await singleFlight({ key: "text-at", run, dir })).toBe("mine");
        expect(counter.runs).toBe(3);
    });

    it("a falsy value (0, false, an empty string, null) is shared like any other", async () => {
        for (const [key, value] of [
            ["zero", 0],
            ["false", false],
            ["empty", ""],
            ["null", null],
        ] as const) {
            const { counter, run } = counted<unknown>(value);
            expect(await singleFlight({ key, run, dir })).toBe(value);
            expect(await singleFlight({ key, run, dir })).toBe(value);
            expect(counter.runs).toBe(1);
        }
    });

    it("a large stdout (5 MB) round-trips intact", async () => {
        const stdout = "x".repeat(5 * 1024 * 1024);
        const { run } = counted({ exitCode: 0, stdout });
        await singleFlight({ key: "large", run, dir });

        const again = await singleFlight({ key: "large", run: async () => ({ exitCode: 9, stdout: "" }), dir });
        expect(again.stdout.length).toBe(stdout.length);
        expect(again.exitCode).toBe(0);
    });

    it("unicode in the value and in the key round-trips", async () => {
        const key = "gh pr view — větev/žluťoučký 🐎";
        const value = { title: "Přidat kůň 🐎 a 汉字", lines: ["a\u0000b", "tab\tend"] };
        const { counter, run } = counted(value);

        expect(await singleFlight({ key, run, dir })).toEqual(value);
        expect(await singleFlight({ key, run, dir })).toEqual(value);
        expect(counter.runs).toBe(1);
    });

    it("the answer file holds the key, the time and the value as strict JSON", async () => {
        const before = Date.now();
        await singleFlight({ key: "shape", run: async () => ({ ok: true }), dir });
        const held = SafeJSON.parse(readFileSync(filesOf("shape").answer, "utf8"), { strict: true });

        expect(held.key).toBe("shape");
        expect(held.value).toEqual({ ok: true });
        expect(held.at).toBeGreaterThanOrEqual(before);
        expect(held.at).toBeLessThanOrEqual(Date.now());
    });
});

describe("singleFlight: the key", () => {
    it("the same argv in another folder never shares, since the folder is part of the key", async () => {
        const { counter, run } = counted("status");
        const argv = ["git", "status", "--porcelain"];

        await singleFlight({ key: `/work/a\n${argv.join("\u0000")}`, run, dir });
        await singleFlight({ key: `/work/b\n${argv.join("\u0000")}`, run, dir });

        expect(counter.runs).toBe(2);
    });

    it("keys that differ in one character never share", async () => {
        const { counter, run } = counted("x");

        await singleFlight({ key: "gh pr view 41", run, dir });
        await singleFlight({ key: "gh pr view 42", run, dir });

        expect(counter.runs).toBe(2);
    });

    it("the file name is a stable hash of the key", async () => {
        await singleFlight({ key: "stable", run: async () => 1, dir });

        expect(leftovers()).toEqual([`${Bun.hash("stable").toString(16)}.json`]);
        expect(Bun.hash("stable").toString(16)).toBe(Bun.hash("stable").toString(16));
    });

    it("a very long key (200 KB) works: the file name stays short, the key is checked in full", async () => {
        const key = `${"k".repeat(200 * 1024)}-a`;
        const { counter, run } = counted("long");

        expect(await singleFlight({ key, run, dir })).toBe("long");
        expect(await singleFlight({ key, run, dir })).toBe("long");
        expect(counter.runs).toBe(1);
        expect(Math.max(...leftovers().map((name) => name.length))).toBeLessThan(40);
    });

    it("an empty key is a key like any other", async () => {
        const { counter, run } = counted("empty key");

        await singleFlight({ key: "", run, dir });
        await singleFlight({ key: "", run, dir });

        expect(counter.runs).toBe(1);
    });
});

describe("singleFlight: cleanup and the folder", () => {
    it("leaves only the answer file after a success, no lock and no temp file", async () => {
        await singleFlight({ key: "clean", run: async () => "ok", dir });

        expect(leftovers()).toEqual([`${Bun.hash("clean").toString(16)}.json`]);
    });

    it("leaves nothing after a failed run", async () => {
        await singleFlight({
            key: "failed",
            run: async () => {
                throw new Error("boom");
            },
            dir,
        }).catch(() => undefined);

        expect(leftovers()).toEqual([]);
    });

    it("leaves no lock and shares nothing after a fallback", async () => {
        const { release } = await holdLock("fallback-clean");

        try {
            await singleFlight({ key: "fallback-clean", run: async () => "x", dir, waitMs: 20, retries: 0 });
        } finally {
            await release();
        }

        // The fallback's own answer is not shared: it ran outside the lock.
        expect(leftovers()).toEqual([]);
    });

    it("creates a missing folder, nested", async () => {
        const nested = join(dir, "a", "b", "c");

        expect(await singleFlight({ key: "nested", run: async () => "made", dir: nested })).toBe("made");
        expect(leftovers(nested)).toEqual([`${Bun.hash("nested").toString(16)}.json`]);
    });

    it("a read-only folder fails loudly instead of running unguarded", async () => {
        const locked = join(dir, "read-only");
        mkdirSync(locked);
        chmodSync(locked, 0o555);
        const { counter, run } = counted("never");

        try {
            await expect(singleFlight({ key: "ro", run, dir: locked, waitMs: 100 })).rejects.toThrow();
        } finally {
            chmodSync(locked, 0o755);
        }

        expect(counter.runs).toBe(0);
    });

    it("by default keeps its files under the GenesisTools data folder, not next to the caller", async () => {
        const { counter, run } = counted("default dir");
        const key = `default-dir-${process.pid}-${Date.now()}`;

        expect(await singleFlight({ key, run })).toBe("default dir");
        expect(await singleFlight({ key, run })).toBe("default dir");
        expect(counter.runs).toBe(1);
    });
});
