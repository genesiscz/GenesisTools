import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@genesiscz/utils/async";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { type AudioSegment, AudioSession, audioSegmentSchema, salvagedAudioTiming } from "./audio-session";
import type { AudioSource } from "./control";
import { NativeFrameRecorder } from "./native";

const fake = join(moduleDir(import.meta), "__fixtures__", "fake-ax-tool.ts");
// Offline Apple AAC silence, with a finalized edit list declaring the encoder's 2,112 priming frames.
const aacFixtures = [
    {
        rate: 44_100,
        base64: "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAIjG1kYXQA0AAG/RAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOANAABv/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxgAAAcANAABv/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxgAAAcANAABv/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxAABwA0AAG//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADGAAABwA0AAG//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADGAAABwA0AAG//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADEAAHADQAAb/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMYAAAHAAAAxdtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAKxEAAAUAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACQnRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAUAAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAFAAAAAhAAAEAAAAAAbptZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAKxEAAAcQFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAFlbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEpc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAKxEAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAZ9rAAGfawWAgIACEggGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAABwAABAAAAAABAAAAQAAAABxzdHNjAAAAAAAAAAEAAAABAAAACAAAAAEAAAA0c3RzegAAAAAAAAAAAAAACAAAAOUAAAEXAAABFwAAARYAAAEXAAABFwAAARYAAAEXAAAAFHN0Y28AAAAAAAAAAQAAACwAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAAACAAAAAEAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAy",
    },
    {
        rate: 48_000,
        base64: "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAH1G1kYXQA0AAG+4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4A0AAG/sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOANAABv7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgDQAAb+wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4A0AAG/sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOANAABv7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgDQAAb+wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4A0AAG/sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAADF21vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAu4AAABQAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAJCdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAABQAAAAAAAAAAAAAAAABAQAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAUAAAACEAAAQAAAAABum1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAu4AAABxAVcQAAAAAAC1oZGxyAAAAAAAAAABzb3VuAAAAAAAAAAAAAAAAU291bmRIYW5kbGVyAAAAAWVtaW5mAAAAEHNtaGQAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASlzdGJsAAAAZ3N0c2QAAAAAAAAAAQAAAFdtcDRhAAAAAAAAAAEAAAAAAAAAAAABABAAAAAAu4AAAAAAADNlc2RzAAAAAAOAgIAiAAEABICAgBRAFQAAAAABnf4AAZ3+BYCAgAIRiAaAgIABAgAAACBzdHRzAAAAAAAAAAIAAAAHAAAEAAAAAAEAAABAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAIAAAAAQAAADRzdHN6AAAAAAAAAAAAAAAIAAAAzAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAAUc3RjbwAAAAAAAAABAAAALAAAABpzZ3BkAQAAAHJvbGwAAAACAAAAAf//AAAAHHNiZ3AAAAAAcm9sbAAAAAEAAAAIAAAAAQAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDI=",
    },
];
const folder = () => mkdtempSync(join(tmpdir(), "audio-session-"));
const rows = (dir: string) =>
    readFileSync(join(dir, "audio.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => audioSegmentSchema.parse(SafeJSON.parse(line, { strict: true })));
const start = (dir: string, mode?: string, onSegment?: (segment: AudioSegment) => void) =>
    AudioSession.start({
        folder: dir,
        outDir: join(dir, ".piece", "sound"),
        request: { sources: ["mic", "system"], micDeviceId: "built-in-mic" },
        argv: [process.execPath, fake, ...(mode ? [mode] : [])],
        launch: (argv) => argv,
        onSegment,
    });

describe("continuous sound over the fake tool", () => {
    test("a live level monitor requests no output folder and closes its native session", async () => {
        const argv: string[][] = [];
        const recorder = new NativeFrameRecorder({
            axTool: async () => [process.execPath, fake],
            launch: (args) => {
                argv.push(args);
                return args;
            },
        });
        const first = Promise.withResolvers<unknown>();
        const session = await recorder.monitorLevels({
            request: { sources: ["mic", "system"] },
            onLevels: first.resolve,
        });
        try {
            expect(argv[0]).toContain("--monitor");
            expect(argv[0]).toContain("--without-screen");
            expect(argv[0]).not.toContain("--out");
            expect(await withTimeout(first.promise, 2000, new Error("missing native meter event"))).toMatchObject({
                mic: 0.25,
                system: null,
                input: "Test input",
                output: "Test output",
            });
        } finally {
            expect((await session.stop()).segments).toBe(0);
        }
    });
    test("muted and paused state reaches the process launch before its first samples", async () => {
        const dir = folder();
        const options = {
            folder: dir,
            outDir: join(dir, ".piece", "sound"),
            request: { sources: ["mic", "system"] as AudioSource[] },
            muted: ["mic"] as AudioSource[],
            paused: true,
            argv: [process.execPath, fake],
            launch: (argv: string[]) => argv,
        };
        const session = await AudioSession.start(options);
        try {
            const argv = z
                .array(z.string())
                .parse(SafeJSON.parse(readFileSync(join(options.outDir, "argv.json"), "utf8")));
            expect(argv).toContain("--muted");
            expect(argv[argv.indexOf("--muted") + 1]).toBe("mic");
            expect(argv).toContain("--paused");
        } finally {
            await session.stop();
        }
    });

    test("a process exit reports failure before inherited output pipes close", async () => {
        const dir = folder();
        const failed = Promise.withResolvers<Error>();
        const session = await AudioSession.start({
            folder: dir,
            outDir: join(dir, ".piece", "sound"),
            request: { sources: ["system"] },
            argv: [process.execPath, fake, "--fixture-audio-exit-open-pipes"],
            launch: (argv) => argv,
            onFailure: failed.resolve,
        });
        try {
            const error = await withTimeout(failed.promise, 800, new Error("failure waited for inherited pipes"));
            expect(error.message).toBe("audio-record exited 1 before stop");
        } finally {
            await expect(session.stop()).rejects.toThrow("audio-record exited 1");
        }
    });

    test("AAC salvage subtracts untrimmed encoder frames at the file's rate, and never subtracts them twice", async () => {
        for (const fixture of aacFixtures) {
            const dir = folder();
            const file = join(dir, "audio-000001-system.m4a");
            const at = "2026-11-03T12:00:00.700Z";
            const finalized = Buffer.from(fixture.base64, "base64");
            writeFileSync(file, finalized);
            writeFileSync(
                `${file}.json`,
                SafeJSON.stringify({
                    event: "segment-started",
                    file: "audio-000001-system.m4a",
                    source: "system",
                    zeroAt: at,
                    primingFrames: 2112,
                })
            );
            const complete = await salvagedAudioTiming(file);
            expect(complete).toMatchObject({ at, zeroAt: at });
            // A kill leaves AAC packets without the final edit list. Preserve the packets, remove only that list.
            const cut = Buffer.from(finalized);
            const edit = cut.indexOf("elst");
            expect(edit).toBeGreaterThan(0);
            cut.write("free", edit);
            writeFileSync(file, cut);
            const recovered = await salvagedAudioTiming(file);
            expect(Date.parse(at) - Date.parse(recovered.zeroAt ?? "")).toBeCloseTo((2112 * 1000) / fixture.rate, 0);
            expect(complete.primingFrames).toBe(0);
            expect(recovered.at).toBe(at);
            expect(recovered.primingFrames).toBe(2112);
            expect(recovered.primingGuess).toBeUndefined();
            expect(recovered.durationMs).toBeGreaterThan(100);
        }
    });

    test("lost spans survive the fake tool, callback and reopened ledger; older rows still parse", async () => {
        const dir = folder();
        const delivered: AudioSegment[] = [];
        const session = await start(dir, "--fixture-audio-loss", (segment) => delivered.push(segment));
        await session.stop();
        expect(rows(dir).map((row) => row.lostSpans)).toEqual([[[100, 1750]], [[100, 1750]]]);
        expect(delivered.map((row) => row.lostSpans)).toEqual([[[100, 1750]], [[100, 1750]]]);
        const oldDir = folder();
        const old = await start(oldDir);
        await old.stop();
        expect(rows(oldDir).every((row) => row.lostSpans === undefined)).toBe(true);
    });

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
        const file = join(dir, ".piece", "sound", "audio-000001-system.m4a");
        expect(existsSync(file)).toBe(true);
        const saved = SafeJSON.parse(readFileSync(`${file}.json`, "utf8"), { strict: true });
        expect(saved).toEqual({
            event: "segment-started",
            file: "audio-000001-system.m4a",
            source: "system",
            zeroAt: "2026-11-03T12:00:00.700Z",
        });
        expect(await salvagedAudioTiming(file)).toEqual({
            at: "2026-11-03T12:00:00.700Z",
            zeroAt: "2026-11-03T12:00:00.700Z",
            durationMs: 1250,
        });
    });

    test("an older or unreadable open file keeps marked file-time guesses", async () => {
        const dir = folder();
        const session = await start(dir, "--fixture-audio-three");
        await session.stop();
        const file = join(dir, rows(dir)[0].file);
        const recovered = await salvagedAudioTiming(file);
        expect(recovered.at).toEqual(expect.any(String));
        expect(recovered.zeroAt).toBeUndefined();
        expect(recovered.clockGuess).toBe("file-times");
        expect(recovered.durationGuess).toBe("file-times");
        expect(recovered.durationMs).toBeGreaterThanOrEqual(0);
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
