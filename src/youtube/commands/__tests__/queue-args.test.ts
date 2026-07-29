import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Command } from "commander";

/**
 * The numeric arguments of `tools youtube queue`, at the command layer.
 *
 * `queue.test.ts` covers `QueueService`; nothing covered the CLI's own parsing,
 * which is where a bad `--limit` or a mistyped id turns into a `NaN` reaching
 * SQLite or a silently disabled timeout.
 */
const calls = {
    list: [] as unknown[],
    get: [] as unknown[],
    cancel: [] as unknown[],
    watch: [] as unknown[],
};

mock.module("@app/youtube/commands/_shared/ensure-pipeline", () => ({
    getYoutube: async () => ({
        queue: {
            list: (opts: unknown) => {
                calls.list.push(opts);
                return [];
            },
            get: (...args: unknown[]) => {
                calls.get.push(args);
                return null;
            },
            cancel: (...args: unknown[]) => {
                calls.cancel.push(args);
                return null;
            },
            watch: (opts: unknown) => {
                calls.watch.push(opts);
                return (async function* () {})();
            },
            stats: () => ({ queued: 0, running: 0, oldestQueuedAgeSec: null, perStage: {} }),
        },
    }),
}));

async function run(argv: string[]): Promise<void> {
    const { registerQueueCommand } = await import("@app/youtube/commands/queue");
    const program = new Command().exitOverride().option("--json").option("--clipboard");
    registerQueueCommand(program);
    await program.parseAsync(["node", "test", ...argv]);
}

/**
 * Read through a call so the assertion is not narrowed by the `process.exitCode
 * = undefined` reset that precedes it in the same scope.
 */
function exitCode(): typeof process.exitCode {
    return process.exitCode;
}

describe("queue command numeric arguments", () => {
    let stderr = "";
    let stderrSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        calls.list = [];
        calls.get = [];
        calls.cancel = [];
        calls.watch = [];
        stderr = "";
        process.exitCode = undefined;
        stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            stderr += String(chunk);
            return true;
        });
    });

    afterEach(() => {
        stderrSpy.mockRestore();
        process.exitCode = 0;
    });

    it("rejects a malformed --limit without calling the facade", async () => {
        await run(["queue", "list", "--limit", "20abc"]);

        expect(calls.list).toEqual([]);
        expect(exitCode()).toBe(1);
        expect(stderr).toContain("--limit");
    });

    it("rejects zero, negative and whitespace-only limits", async () => {
        for (const value of ["0", "-5", "   "]) {
            calls.list = [];
            process.exitCode = undefined;
            await run(["queue", "list", "--limit", value]);

            expect(calls.list).toEqual([]);
            expect(exitCode()).toBe(1);
        }
    });

    // Unsafe integers lose precision the moment they are parsed, so an id or a
    // limit past 2^53 is never what the caller typed.
    it("rejects an unsafe integer", async () => {
        await run(["queue", "list", "--limit", "999999999999999999999"]);

        expect(calls.list).toEqual([]);
        expect(exitCode()).toBe(1);
    });

    it("accepts a well-formed limit", async () => {
        await run(["queue", "list", "--limit", "5"]);

        expect(calls.list).toHaveLength(1);
        expect(calls.list[0]).toMatchObject({ limit: 5 });
    });

    it("rejects a non-numeric job id for show and cancel", async () => {
        await run(["queue", "show", "typo"]);

        expect(calls.get).toEqual([]);
        expect(exitCode()).toBe(1);

        process.exitCode = undefined;
        await run(["queue", "cancel", "12abc"]);

        expect(calls.cancel).toEqual([]);
        expect(exitCode()).toBe(1);
    });

    // The dangerous one: with the id dropped, `watch` means "everything active".
    it("refuses a mistyped watch id instead of watching the whole queue", async () => {
        await run(["queue", "watch", "typo"]);

        expect(calls.watch).toEqual([]);
        expect(exitCode()).toBe(1);
    });

    it("rejects a non-numeric --timeout rather than disabling it", async () => {
        await run(["queue", "watch", "--timeout", "soon"]);

        expect(calls.watch).toEqual([]);
        expect(exitCode()).toBe(1);
        expect(stderr).toContain("--timeout");
    });

    it("passes a valid timeout through as milliseconds", async () => {
        await run(["queue", "watch", "--timeout", "30"]);

        expect(calls.watch).toHaveLength(1);
        expect(calls.watch[0]).toMatchObject({ timeoutMs: 30_000 });
    });
});
