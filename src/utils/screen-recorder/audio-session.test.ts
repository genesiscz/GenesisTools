import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@genesiscz/utils/async";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { AudioSession, audioSegmentSchema } from "./audio-session";
import type { AudioSource } from "./control";

const fake = join(moduleDir(import.meta), "__fixtures__", "fake-ax-tool.ts");
const folder = () => mkdtempSync(join(tmpdir(), "audio-session-"));
const rows = (dir: string) =>
    readFileSync(join(dir, "audio.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => audioSegmentSchema.parse(SafeJSON.parse(line, { strict: true })));
const start = (dir: string, mode?: string, onSegment?: () => void) =>
    AudioSession.start({
        folder: dir,
        outDir: join(dir, ".piece", "sound"),
        request: { sources: ["mic", "system"], micDeviceId: "built-in-mic" },
        argv: [process.execPath, fake, ...(mode ? [mode] : [])],
        launch: (argv) => argv,
        onSegment,
    });

describe("continuous sound over the fake tool", () => {
    test("three closed segments per source have no gap, and survive reopening the ledger", async () => {
        const dir = folder();
        const complete = Promise.withResolvers<void>();
        let count = 0;
        const session = await start(dir, "--fixture-audio-three", () => {
            count += 1;
            if (count === 6) {
                complete.resolve();
            }
        });
        try {
            await withTimeout(complete.promise, 1000, new Error("segments did not arrive"));
        } finally {
            await session.stop();
        }
        const kept = rows(dir);
        for (const source of ["mic", "system"] satisfies AudioSource[]) {
            const track = kept.filter((row) => row.source === source);
            expect(track).toHaveLength(3);
            for (let index = 1; index < 3; index++) {
                expect(Date.parse(track[index].zeroAt) - Date.parse(track[index - 1].zeroAt)).toBe(
                    track[index - 1].durationMs
                );
            }
        }
        expect(kept.every((row) => existsSync(join(dir, row.file)))).toBe(true);
    });

    test("mute/unmute retain one file and one muted span; repeated stop sends one stop", async () => {
        const dir = folder();
        const session = await start(dir);
        await session.mute("mic", true);
        await session.mute("mic", false);
        const first = session.stop();
        expect(session.stop()).toBe(first);
        expect(await first).toMatchObject({ segments: 2 });
        const kept = rows(dir);
        expect(kept).toHaveLength(2);
        expect(kept.find((row) => row.source === "mic")?.mutedSpans).toEqual([[15_000, 30_000]]);
        expect(kept.find((row) => row.source === "system")?.mutedSpans).toEqual([]);
        const commands = readFileSync(join(dir, ".piece", "sound", "commands.jsonl"), "utf8");
        expect(commands.match(/"cmd":"stop"/g)).toHaveLength(1);
    });

    test("device changes, pause and resume wait for their acknowledgement; refused input keeps the session", async () => {
        const dir = folder();
        const session = await start(dir);
        try {
            await expect(session.setMic("missing")).rejects.toThrow("no input device missing");
            await session.setMic("built-in-mic");
            await session.pause();
            await session.resume();
        } finally {
            await session.stop();
        }
        expect(rows(dir).map((row) => row.source)).toEqual(["mic", "system"]);
    });

    test("an ungranted microphone leaves system only, with one warning", async () => {
        const dir = folder();
        const session = await start(dir, "--fixture-no-mic-grant");
        expect(session.sources).toEqual(["system"]);
        expect((await session.stop()).warnings).toEqual([
            "the microphone is not granted; the recording keeps the system sound only",
        ]);
        expect(rows(dir).map((row) => row.source)).toEqual(["system"]);
    });

    test("a crashed process reports failure and leaves its open file for salvage", async () => {
        const dir = folder();
        const session = await start(dir, "--fixture-audio-crash").catch((error: unknown) => error);
        if (session instanceof AudioSession) {
            await expect(session.stop()).rejects.toThrow("audio-record exited 1");
        } else {
            expect(session).toBeInstanceOf(Error);
        }
        expect(existsSync(join(dir, ".piece", "sound", "audio-000001-system.m4a"))).toBe(true);
    });

    test("a ledger write failure leaves the closed file where recovery can salvage it", async () => {
        const dir = folder();
        mkdirSync(join(dir, "audio.jsonl"));
        const session = await start(dir, "--fixture-audio-three").catch((error: unknown) => error);
        if (session instanceof AudioSession) {
            await expect(session.stop()).rejects.toThrow();
        } else {
            expect(session).toBeInstanceOf(Error);
        }
        expect(existsSync(join(dir, ".piece", "sound", "audio-000001-mic.m4a"))).toBe(true);
        expect(readdirSync(join(dir, "audio"))).toEqual([]);
    });
});
