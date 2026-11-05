import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { InputGuard, OverwriteInputError } from "./guard";
import { JobCancelledError, JobRegistry, type JobStep, runJob } from "./runner";
import type { ProgressEvent } from "./types";

function workspace(): string {
    return mkdtempSync(join(tmpdir(), "gt-jobs-"));
}

interface Counted {
    files: string[];
}

function writer(dir: string, name: string, runs: string[]): JobStep<Counted> {
    return {
        name,
        key: { name },
        outputs: (state) => state.files,
        run: async (ctx) => {
            runs.push(name);
            const path = ctx.claim(join(dir, `${name}.txt`));
            writeFileSync(path, name);
            ctx.progress({ done: 1, total: 1, unit: "files" });
            return { files: [...ctx.state.files, path] };
        },
    };
}

describe("job runner", () => {
    test("initialization failure finishes the job and releases its caller signal", async () => {
        const controller = new AbortController();
        const circular: { self?: unknown } = {};
        circular.self = circular;
        const job = runJob({
            kind: "test",
            initial: null,
            fingerprint: circular,
            signal: controller.signal,
            steps: [{ name: "unused", key: 1, run: async () => null }],
        });
        await expect(job.done).rejects.toThrow();
        expect(job.state).toBe("failed");
        expect(job.info().endedAt).toBeDefined();
        controller.abort();
        expect(job.signal.aborted).toBe(false);
        const normal = runJob({ kind: "test", initial: null, signal: new AbortController().signal, steps: [] });
        await normal.done;
        expect(normal.state).toBe("done");
    });

    test("steps run in order, report progress, and a rerun skips the steps its receipts cover", async () => {
        const dir = workspace();
        const runs: string[] = [];
        const events: ProgressEvent[] = [];
        const steps = [writer(dir, "a", runs), writer(dir, "b", runs)];
        const first = runJob({ kind: "test", initial: { files: [] }, steps, receipts: join(dir, ".receipts") });
        first.on("progress", (event) => events.push(event));
        const result = await first.done;
        expect(result.state.files.map((file) => file.slice(-5))).toEqual(["a.txt", "b.txt"]);
        expect(runs).toEqual(["a", "b"]);
        expect(first.state).toBe("done");
        expect(events.every((event) => event.job === first.id && typeof event.at === "string")).toBe(true);
        expect(events.filter((event) => event.unit === "files")).toHaveLength(2);

        const again = await runJob({ kind: "test", initial: { files: [] }, steps, receipts: join(dir, ".receipts") })
            .done;
        expect(runs).toEqual(["a", "b"]);
        expect(again.steps.map((step) => step.skipped)).toEqual([true, true]);
        expect(again.state).toEqual(result.state);

        const longer = [...steps, writer(dir, "c", runs)];
        await runJob({ kind: "test", initial: { files: [] }, steps: longer, receipts: join(dir, ".receipts") }).done;
        expect(runs).toEqual(["a", "b", "c"]);

        const other = await runJob({
            kind: "test",
            initial: { files: [] },
            steps,
            receipts: join(dir, ".receipts"),
            fingerprint: "another source",
        }).done;
        expect(other.steps.map((step) => step.skipped)).toEqual([false, false]);
    });

    test("a receipt whose outputs are gone runs its step again", async () => {
        const dir = workspace();
        const runs: string[] = [];
        const steps = [writer(dir, "a", runs)];
        await runJob({ kind: "test", initial: { files: [] }, steps, receipts: join(dir, "r") }).done;
        unlinkSync(join(dir, "a.txt"));
        await runJob({ kind: "test", initial: { files: [] }, steps, receipts: join(dir, "r") }).done;
        expect(runs).toEqual(["a", "a"]);
    });

    test("a step never writes an input, and the guard sees through a relative or symlinked spelling", async () => {
        const dir = workspace();
        const input = join(dir, "input.mp4");
        writeFileSync(input, "x");
        const guard = new InputGuard([input]);
        expect(() => guard.claim(join(dir, ".", "input.mp4"))).toThrow(OverwriteInputError);
        const alias = join(dir, "alias.mp4");
        symlinkSync(input, alias);
        expect(() => guard.claim(alias)).toThrow(OverwriteInputError);
        expect(() => guard.claim(relative(process.cwd(), input))).toThrow(OverwriteInputError);
        const folderGuard = new InputGuard([dir]);
        expect(() => folderGuard.claim(dir)).toThrow(OverwriteInputError);
        expect(folderGuard.claim(input)).toBe(guard.claim(join(dir, "output.mp4")).replace("output.mp4", "input.mp4"));
        expect(guard.claim(join(dir, "output.mp4"))).toBe(join(dir, "output.mp4"));

        const job = runJob({
            kind: "test",
            initial: null,
            inputs: [input],
            steps: [
                {
                    name: "export",
                    run: async (ctx) => {
                        ctx.claim(input);
                        return null;
                    },
                },
            ],
        });
        await expect(job.done).rejects.toThrow(OverwriteInputError);
        expect(job.state).toBe("failed");
    });

    test("cancel stops before the next step and rejects with JobCancelledError", async () => {
        let release: () => void = () => undefined;
        const ran: string[] = [];
        const job = runJob({
            kind: "test",
            initial: 0,
            steps: [
                {
                    name: "slow",
                    run: async () => {
                        await new Promise<void>((resolve) => {
                            release = resolve;
                        });
                        ran.push("slow");
                        return 1;
                    },
                },
                {
                    name: "never",
                    run: async () => {
                        ran.push("never");
                        return 2;
                    },
                },
            ],
        });
        await Bun.sleep(1);
        job.cancel();
        release();
        await expect(job.done).rejects.toThrow(JobCancelledError);
        expect(job.state).toBe("cancelled");
        expect(ran).toEqual(["slow"]);
    });

    test("a registry lists its jobs and forwards every event", async () => {
        const seen: string[] = [];
        const registry = new JobRegistry((event) => seen.push(`${event.step}:${event.done}/${event.total}`));
        const job = registry.task("ocr", async (ctx) => {
            ctx.progress({ done: 3, total: 4, unit: "frames" });
            return "ok";
        });
        expect((await job.done).state).toBe("ok");
        expect(registry.list()).toMatchObject([{ id: job.id, kind: "ocr", state: "done" }]);
        expect(seen).toContain("ocr:3/4");
    });
});

test("an unwritable receipt cache cannot turn successful work into a failed job", async () => {
    const receipts = join(workspace(), "receipts");
    writeFileSync(receipts, "not a directory");
    const job = runJob({
        id: "unwritable-receipt",
        kind: "fixture",
        initial: 0n,
        receipts,
        steps: [{ name: "value", key: "v1", run: async () => 1n }],
    });
    expect((await job.done).state).toBe(1n);
    expect(job.info().state).toBe("done");
});

test("resumed receipts retain dynamically protected inputs", async () => {
    const dir = workspace();
    const source = join(dir, "source.txt");
    writeFileSync(source, "original");
    let discovered = 0;
    const steps: JobStep<string>[] = [
        {
            name: "discover",
            key: 1,
            run: async (ctx) => {
                discovered++;
                ctx.addInput(source);
                return source;
            },
        },
        {
            name: "export",
            run: async (ctx) => {
                writeFileSync(ctx.claim(ctx.state), "overwritten");
                return ctx.state;
            },
        },
    ];
    for (let run = 0; run < 2; run++) {
        await expect(
            runJob({ kind: "test", initial: "", steps, receipts: join(dir, "receipts") }).done
        ).rejects.toBeInstanceOf(OverwriteInputError);
    }
    expect(discovered).toBe(1);
    expect(await Bun.file(source).text()).toBe("original");
});
