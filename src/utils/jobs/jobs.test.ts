import { describe, expect, test } from "bun:test";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
