import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelHandle } from "@app/youtube/lib/types";
import { Command } from "commander";

mock.module("@app/utils/cli/executor", () => ({
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
        stdout = "";
        stderr = "";
        process.exitCode = undefined;
        stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            stdout += String(chunk);
            return true;
        });
        stderrSpy = spyOn(console, "error").mockImplementation((chunk?: unknown) => {
            stderr += `${String(chunk)}\n`;
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

    it("syncs all saved channels", async () => {
        fakeYoutube.channels = [
            { handle: "@mkbhd", title: "MKBHD", lastSyncedAt: null },
            { handle: "@veritasium", title: "Veritasium", lastSyncedAt: null },
        ];
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "channels", "sync", "--all", "--limit", "5", "--include-shorts"]);

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
