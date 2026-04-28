import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { JobStage, PipelineJob } from "@app/youtube/lib/types";
import { Command } from "commander";

const jobs: PipelineJob[] = [];
const calls = {
    enqueue: [] as unknown[],
    start: 0,
};

const pinned: Array<{ id: string; pinned: boolean }> = [];

mock.module("@app/youtube/commands/_shared/ensure-pipeline", () => ({
    getYoutube: async () => ({
        db: {
            setVideoPinned: (id: string, pin: boolean) => {
                pinned.push({ id, pinned: pin });
            },
        },
        pipeline: {
            enqueue: (input: unknown) => {
                calls.enqueue.push(input);
                const job: PipelineJob = {
                    id: jobs.length + 1,
                    targetKind: "video",
                    target: (input as { target: string }).target,
                    stages: (input as { stages: JobStage[] }).stages,
                    currentStage: null,
                    status: "completed",
                    error: null,
                    progress: 1,
                    progressMessage: null,
                    parentJobId: null,
                    workerId: null,
                    claimedAt: null,
                    createdAt: "2026-04-01",
                    updatedAt: "2026-04-01",
                    completedAt: "2026-04-01",
                };
                jobs.push(job);

                return job;
            },
            start: async () => {
                calls.start++;
            },
            getJob: (id: number) => jobs.find((job) => job.id === id) ?? null,
            on: () => () => undefined,
        },
    }),
}));

async function makeProgram(): Promise<Command> {
    const { registerDownloadCommand } = await import("@app/youtube/commands/download");
    const program = new Command().exitOverride().option("--json").option("--clipboard").option("--silent");
    registerDownloadCommand(program);

    return program;
}

describe("youtube download command", () => {
    let stdout = "";
    let stderr = "";
    let stdoutSpy: ReturnType<typeof spyOn>;
    let stderrSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        jobs.length = 0;
        calls.enqueue = [];
        calls.start = 0;
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

    it("defaults to metadata and audio stages", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "download", "dQw4w9WgXcQ"]);

        expect(calls.enqueue[0]).toEqual({ targetKind: "video", target: "dQw4w9WgXcQ", stages: ["metadata", "audio"] });
        expect(calls.start).toBe(1);
        expect(stdout).toContain("completed");
    });

    it("adds video stage for --video and resolves URL target kind", async () => {
        const program = await makeProgram();

        await program.parseAsync([
            "node",
            "test",
            "download",
            "https://youtu.be/dQw4w9WgXcQ",
            "--video",
            "--quality",
            "1080p",
        ]);

        expect(calls.enqueue[0]).toEqual({
            targetKind: "url",
            target: "https://youtu.be/dQw4w9WgXcQ",
            stages: ["metadata", "audio", "video"],
        });
    });

    it("resolves channel target kind", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "download", "@mkbhd", "--audio"]);

        expect(calls.enqueue[0]).toMatchObject({ targetKind: "channel", target: "@mkbhd" });
    });

    it("prints keep hint unless silent", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "download", "dQw4w9WgXcQ", "--keep"]);

        expect(stderr).toContain("--keep applied");
        expect(pinned).toEqual([{ id: "dQw4w9WgXcQ", pinned: true }]);
    });
});
