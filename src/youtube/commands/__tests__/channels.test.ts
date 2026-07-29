import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleUserDbFake } from "@app/youtube/commands/__tests__/console-user-fake";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { Pipeline } from "@app/youtube/lib/pipeline";
import type { EnqueuePipelineResult } from "@app/youtube/lib/pipeline.types";
import { QueueService } from "@app/youtube/lib/queue";
import type { ChannelHandle, JobStage, PipelineJob } from "@app/youtube/lib/types";
import { Command } from "commander";

mock.module("@genesiscz/utils/cli/executor", () => ({
    isInteractive: () => false,
    suggestCommand: (toolName: string, mods: { add?: string[] } = {}) => `${toolName} ${(mods.add ?? []).join(" ")}`,
    enhanceHelp: () => undefined,
}));

interface FakeChannel {
    handle: ChannelHandle;
    title: string | null;
    lastSyncedAt: string | null;
}

const fakeYoutube = {
    added: [] as ChannelHandle[],
    removed: [] as ChannelHandle[],
    synced: [] as Array<{ handle: ChannelHandle; opts: { limit?: number; includeShorts?: boolean } }>,
    channels: [] as FakeChannel[],
};

const jobs: PipelineJob[] = [];
const calls = {
    enqueue: [] as unknown[],
};
const fakeDb = consoleUserDbFake() as unknown as YoutubeDatabase;
const fakePipeline = {
    enqueue: (input: unknown): EnqueuePipelineResult => {
        calls.enqueue.push(input);
        const job: PipelineJob = {
            id: jobs.length + 1,
            targetKind: (input as { targetKind: PipelineJob["targetKind"] }).targetKind,
            target: (input as { target: string }).target,
            stages: (input as { stages: JobStage[] }).stages,
            currentStage: null,
            status: "pending",
            error: null,
            progress: 0,
            progressMessage: null,
            parentJobId: null,
            userId: null,
            workerId: null,
            claimedAt: null,
            createdAt: "2026-04-01",
            updatedAt: "2026-04-01",
            completedAt: null,
            priority: 50,
            params: null,
            fingerprint: null,
        };
        jobs.push(job);

        return { job, reused: false, queuePosition: jobs.length };
    },
};
const queue = new QueueService(fakePipeline as unknown as Pipeline, fakeDb);

mock.module("@app/youtube/commands/_shared/ensure-pipeline", () => ({
    getYoutube: async () => ({
        channels: {
            add: async (handle: ChannelHandle) => {
                fakeYoutube.added.push(handle);
            },
            list: () => fakeYoutube.channels,
            remove: (handle: ChannelHandle) => {
                fakeYoutube.removed.push(handle);
            },
            sync: async (handle: ChannelHandle, opts: { limit?: number; includeShorts?: boolean }) => {
                fakeYoutube.synced.push({ handle, opts });

                return 3;
            },
        },
        db: fakeDb,
        pipeline: fakePipeline,
        queue,
    }),
}));

async function makeProgram(): Promise<Command> {
    const { registerChannelsCommand } = await import("@app/youtube/commands/channels");
    const program = new Command().exitOverride().option("--json").option("--clipboard");
    registerChannelsCommand(program);

    return program;
}

describe("youtube channels command", () => {
    let stdout = "";
    let stderr = "";
    let stdoutSpy: ReturnType<typeof spyOn>;
    let stderrSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        fakeYoutube.added = [];
        fakeYoutube.removed = [];
        fakeYoutube.synced = [];
        fakeYoutube.channels = [];
        jobs.length = 0;
        calls.enqueue = [];
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

    it("adds variadic handles and normalises bare names", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "channels", "add", "@mkbhd", "veritasium"]);

        expect(fakeYoutube.added).toEqual(["@mkbhd", "@veritasium"]);
        expect(stdout).toContain("Added 2 channel(s)");
    });

    it("reads handles from --from-file and normalises YouTube URLs", async () => {
        const dir = mkdtempSync(join(tmpdir(), "youtube-channels-"));
        const file = join(dir, "handles.txt");
        writeFileSync(file, "https://www.youtube.com/@mkbhd\nveritasium\n");
        const program = await makeProgram();

        try {
            await program.parseAsync(["node", "test", "channels", "add", "--from-file", file]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }

        expect(fakeYoutube.added).toEqual(["@mkbhd", "@veritasium"]);
    });

    it("removes a channel with --yes", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "channels", "remove", "mkbhd", "--yes"]);

        expect(fakeYoutube.removed).toEqual(["@mkbhd"]);
    });

    it("enqueues a sync job per saved channel", async () => {
        fakeYoutube.channels = [
            { handle: "@mkbhd", title: "MKBHD", lastSyncedAt: null },
            { handle: "@veritasium", title: "Veritasium", lastSyncedAt: null },
        ];
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "channels", "sync", "--all", "--limit", "5", "--include-shorts"]);

        expect(calls.enqueue).toMatchObject([
            {
                targetKind: "channel",
                target: "@mkbhd",
                stages: ["discover", "metadata"],
                params: { limit: 5, includeShorts: true },
            },
            {
                targetKind: "channel",
                target: "@veritasium",
                stages: ["discover", "metadata"],
                params: { limit: 5, includeShorts: true },
            },
        ]);
    });

    it("runs synchronously and reports per-channel counts with --sync", async () => {
        fakeYoutube.channels = [
            { handle: "@mkbhd", title: "MKBHD", lastSyncedAt: null },
            { handle: "@veritasium", title: "Veritasium", lastSyncedAt: null },
        ];
        const program = await makeProgram();

        await program.parseAsync([
            "node",
            "test",
            "channels",
            "sync",
            "--all",
            "--limit",
            "5",
            "--include-shorts",
            "--sync",
        ]);

        expect(fakeYoutube.synced).toEqual([
            { handle: "@mkbhd", opts: { limit: 5, includeShorts: true } },
            { handle: "@veritasium", opts: { limit: 5, includeShorts: true } },
        ]);
    });

    it("prints a non-interactive hint when add has no handles", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "channels", "add"]);

        expect(stderr).toContain("channels add requires at least one handle");
        expect(stderr).toContain("tools youtube channels add");
        expect(process.exitCode).toBe(1);
    });
});
