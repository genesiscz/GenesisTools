import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { EnqueuePipelineResult } from "@app/youtube/lib/pipeline.types";
import type { JobStage, PipelineJob } from "@app/youtube/lib/types";
import { Command } from "commander";

const jobs: PipelineJob[] = [];
const calls = {
    enqueue: [] as unknown[],
    concurrency: [] as Array<number | null>,
    start: 0,
    on: [] as string[],
};

mock.module("@app/youtube/commands/_shared/ensure-pipeline", () => ({
    getYoutube: async () => ({
        pipeline: {
            // Typed as the real return so this mock can't silently drift from
            // `Pipeline.enqueue` again — it used to hand back a bare job, while
            // production destructures `{ job }`, so every command test threw
            // "enqueue returned no job".
            enqueue: (input: unknown): EnqueuePipelineResult => {
                calls.enqueue.push(input);
                const job: PipelineJob = {
                    id: jobs.length + 1,
                    targetKind: (input as { targetKind: PipelineJob["targetKind"] }).targetKind,
                    target: (input as { target: string }).target,
                    stages: (input as { stages: JobStage[] }).stages,
                    currentStage: null,
                    status: "completed",
                    error: null,
                    progress: 1,
                    progressMessage: null,
                    parentJobId: null,
                    userId: null,
                    workerId: null,
                    claimedAt: null,
                    createdAt: "2026-04-01",
                    updatedAt: "2026-04-01",
                    completedAt: "2026-04-01",
                    priority: 50,
                    params: null,
                    fingerprint: null,
                };
                jobs.push(job);

                return { job, reused: false, queuePosition: jobs.length };
            },
            setGlobalConcurrencyOverride: (value: number | null) => {
                calls.concurrency.push(value);
            },
            start: async () => {
                calls.start++;
            },
            getJob: (id: number) => jobs.find((job) => job.id === id) ?? null,
            on: (event: string) => {
                calls.on.push(event);

                return () => undefined;
            },
        },
    }),
}));

async function makeProgram(): Promise<Command> {
    const { registerPipelineCommand } = await import("@app/youtube/commands/pipeline");
    const program = new Command().exitOverride().option("--json").option("--clipboard").option("--silent");
    registerPipelineCommand(program);

    return program;
}

describe("youtube pipeline command", () => {
    let stdout = "";
    let stderr = "";
    let stdoutSpy: ReturnType<typeof spyOn>;
    let stderrSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        jobs.length = 0;
        calls.enqueue = [];
        calls.concurrency = [];
        calls.start = 0;
        calls.on = [];
        stdout = "";
        stderr = "";
        process.exitCode = undefined;
        stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            stdout += String(chunk);
            return true;
        });
        stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            stderr += String(chunk);
            return true;
        });
    });

    afterEach(() => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        process.exitCode = 0;
    });

    it("enqueues default stages for multiple targets", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "pipeline", "dQw4w9WgXcQ", "@mkbhd"]);

        expect(calls.enqueue).toEqual([
            { targetKind: "video", target: "dQw4w9WgXcQ", stages: ["metadata", "captions", "transcribe", "summarize"] },
            { targetKind: "channel", target: "@mkbhd", stages: ["metadata", "captions", "transcribe", "summarize"] },
        ]);
        expect(calls.start).toBe(1);
        expect(stdout).toContain("completed");
    });

    it("parses custom stages and comma-separated targets", async () => {
        const program = await makeProgram();

        await program.parseAsync([
            "node",
            "test",
            "pipeline",
            "a1b2c3d4e5f,https://youtu.be/dQw4w9WgXcQ",
            "--stages",
            "metadata,audio,video",
        ]);

        expect(calls.enqueue).toEqual([
            { targetKind: "video", target: "a1b2c3d4e5f", stages: ["metadata", "audio", "video"] },
            { targetKind: "url", target: "https://youtu.be/dQw4w9WgXcQ", stages: ["metadata", "audio", "video"] },
        ]);
    });

    it("sets global concurrency override", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "pipeline", "dQw4w9WgXcQ", "--concurrency", "4"]);

        expect(calls.concurrency).toEqual([4]);
    });

    it("subscribes to progress in watch mode", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "pipeline", "dQw4w9WgXcQ", "--watch"]);

        expect(calls.on).toContain("stage:progress");
        expect(stderr).toBe("");
    });
});
