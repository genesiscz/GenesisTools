import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLoudness } from "./measure";
import { encodeMidi } from "./midi";
import { mixMusic, musicFilterGraph, placeMusic } from "./mix";
import { publishAudio } from "./process";
import { fluidSynthArgs, renderScore } from "./render";
import { builtinScore, TRACK_KEYS } from "./scores";
import { TAPS, tapAudio, tapAudition } from "./taps";
import { type Score, scoreSchema } from "./types";

const minimal: Score = {
    key: "fixture",
    title: "Fixture",
    bpm: 120,
    seconds: 4,
    end: 3,
    parts: [
        {
            name: "piano",
            program: 0,
            percussion: false,
            volume: 100,
            pan: 64,
            notes: [{ at: 0, duration: 1, midi: 60, velocity: 90 }],
        },
    ],
};
const mix = {
    video: "video.mp4",
    music: "music.wav",
    output: "out.mp4",
    end: 91.5,
    videoSeconds: 93,
    musicSeconds: 95,
    sourceHasAudio: true,
};

describe("music score and MIDI", () => {
    test("keeps all four source compositions as independently built, deterministic data", () => {
        expect(TRACK_KEYS).toEqual(["Pulse", "PulseLight", "Calm", "Piano"]);

        for (const key of TRACK_KEYS) {
            const first = builtinScore(key);
            const second = builtinScore(key);
            expect(scoreSchema.safeParse(first).success).toBe(true);
            expect(first.parts.flatMap((part) => part.notes).length).toBeGreaterThan(100);
            expect(encodeMidi(first)).toEqual(encodeMidi(second));
            expect(first).not.toBe(second);
        }

        expect(builtinScore("pulselight").key).toBe("PulseLight");
        expect(() => builtinScore("unknown")).toThrow("Unknown track");
    });

    test("writes a type-1 MIDI header, tempo and note-on/off evidence", () => {
        const midi = encodeMidi(minimal);
        expect(midi.subarray(0, 4).toString()).toBe("MThd");
        expect(midi.readUInt16BE(8)).toBe(1);
        expect(midi.readUInt16BE(10)).toBe(2);
        expect(midi.readUInt16BE(12)).toBe(480);
        expect(midi.includes(Buffer.from([0xff, 0x51, 3, 0x07, 0xa1, 0x20]))).toBe(true);
        expect(midi.includes(Buffer.from([0x90, 60, 90]))).toBe(true);
        expect(midi.includes(Buffer.from([0x80, 60, 0]))).toBe(true);
    });

    test("keeps drums on channel 10 and skips it for pitched voices", () => {
        const part = minimal.parts[0];
        const score = {
            ...minimal,
            parts: Array.from({ length: 12 }, (_, i) => ({
                ...part,
                name: `part-${i}`,
                percussion: i === 2,
            })),
        };
        const midi = encodeMidi(score);
        expect(midi.includes(Buffer.from([0x99, 60, 90]))).toBe(true);
        expect(midi.includes(Buffer.from([0x9a, 60, 90]))).toBe(true);
        expect(midi.includes(Buffer.from([0x9b, 60, 90]))).toBe(true);
    });

    test("refuses invalid notes and written ends before rendering", () => {
        expect(() => encodeMidi({ ...minimal, end: 5 })).toThrow();
        expect(() =>
            encodeMidi({
                ...minimal,
                parts: [{ ...minimal.parts[0], notes: [{ at: 3.5, duration: 1, midi: 128, velocity: 0 }] }],
            })
        ).toThrow();
    });

    test("pins sample timing, one core and inactive chorus/reverb", () => {
        const args = fluidSynthArgs({ soundfont: "bank.sf2", midi: "score.mid", raw: "raw.wav" });
        expect(args).toContain("synth.cpu-cores=1");
        expect(args).toContain("player.timing-source=sample");
        expect(args.slice(args.indexOf("-R"), args.indexOf("-R") + 4)).toEqual(["-R", "0", "-C", "0"]);
    });
});

describe("placement and effects ducking", () => {
    test("aligns the written end for equal, shorter and longer movies", () => {
        expect(placeMusic({ videoSeconds: 91.5, musicSeconds: 95, end: 91.5 })).toEqual({
            trim: 0,
            delay: 0,
            fadeOutAt: 88.5,
        });
        expect(placeMusic({ videoSeconds: 89.5, musicSeconds: 95, end: 91.5 })).toEqual({
            trim: 2,
            delay: 0,
            fadeOutAt: 86.5,
        });
        expect(placeMusic({ videoSeconds: 93, musicSeconds: 95, end: 91.5 })).toEqual({
            trim: 0,
            delay: 1.5,
            fadeOutAt: 90,
        });
        expect(() => placeMusic({ videoSeconds: Number.NaN, musicSeconds: 95, end: 91.5 })).toThrow();
        expect(() => placeMusic({ videoSeconds: 2, musicSeconds: 1, end: 2 })).toThrow();
    });

    test("fades placed music, keys ducking on effects, and leaves source level unnormalized", () => {
        const graph = musicFilterGraph(mix);
        expect(graph).toContain("adelay=1500:all=1");
        expect(graph).toContain("afade=t=in:st=1.5:d=1.5");
        expect(graph).toContain("afade=t=out:st=90:d=3");
        expect(graph).toContain("[music][key]sidechaincompress=threshold=0.03:ratio=4:attack=8:release=350");
        expect(graph).toContain("normalize=0");
        expect(graph).toContain("alimiter=limit=0.79:level=false:latency=true");
    });

    test("uses a finite silent source for silent video and drains unused key with duck disabled", () => {
        const graph = musicFilterGraph({ ...mix, sourceHasAudio: false, duck: false });
        expect(graph).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=93");
        expect(graph).not.toContain("[0:a");
        expect(graph).toContain("[key]anullsink");
        expect(graph).not.toContain("sidechaincompress");
    });

    test("supports no fades and clamps fade duration for a short video", () => {
        expect(musicFilterGraph({ ...mix, fadeIn: 0, fadeOut: 0 })).not.toContain("afade");
        const short = musicFilterGraph({ ...mix, videoSeconds: 1 });
        expect(short).toContain("atrim=start=90.5");
        expect(short).toContain("afade=t=in:st=0:d=1");
        expect(short).toContain("afade=t=out:st=0:d=1");
        expect(() => musicFilterGraph({ ...mix, ratio: 0 })).toThrow();
    });

    test("refuses input overwrite before probing or starting a process", async () => {
        await expect(mixMusic({ video: "same.mp4", music: "music.wav", output: "same.mp4", end: 1 })).rejects.toThrow(
            "differ"
        );
        await expect(renderScore({ score: minimal, output: "out.wav", targetLufs: 0 })).rejects.toThrow("Target");
    });
});

describe("measurement, effects and publishing", () => {
    test("parses ffmpeg loudness and rejects silence or missing measurement evidence", () => {
        expect(parseLoudness('log\n{"input_i":"-20.04","input_tp":"-6.63"}')).toEqual({
            lufs: -20.04,
            truePeakDb: -6.63,
        });
        expect(() => parseLoudness('{"input_i":"-inf","input_tp":"-inf"}')).toThrow();
        expect(() => parseLoudness("")).toThrow("did not report");
    });

    test("all ten taps are deterministic WAVs with different sample data", () => {
        const hashes = new Set<string>();

        for (const [key] of TAPS) {
            const first = tapAudio(key);
            expect(first).toEqual(tapAudio(key));
            expect(first.subarray(0, 4).toString()).toBe("RIFF");
            expect(first.readUInt32LE(24)).toBe(48000);
            hashes.add(createHash("sha256").update(first).digest("hex"));
        }

        expect(hashes.size).toBe(10);
        expect(tapAudition()).toEqual(tapAudition());
        expect(() => tapAudio("missing")).toThrow("Unknown tap");
    });

    test("never changes an old output after failure and requires explicit replacement", async () => {
        const folder = await mkdtemp(join(tmpdir(), "music-publish-test-"));
        const output = join(folder, "out.wav");

        try {
            await writeFile(output, "old");
            await expect(
                publishAudio({
                    output,
                    overwrite: true,
                    prepare: async (temporary) => {
                        await writeFile(temporary, "partial");
                        throw new Error("encoder failed");
                    },
                })
            ).rejects.toThrow("encoder failed");
            expect(await readFile(output, "utf8")).toBe("old");
            await expect(
                publishAudio({
                    output,
                    prepare: async (temporary) => {
                        await writeFile(temporary, "new");
                    },
                })
            ).rejects.toThrow();
            expect(await readFile(output, "utf8")).toBe("old");
            await publishAudio({
                output,
                overwrite: true,
                prepare: async (temporary) => {
                    await writeFile(temporary, "new");
                },
            });
            expect(await readFile(output, "utf8")).toBe("new");
            expect(await readdir(folder)).toEqual(["out.wav"]);
        } finally {
            await rm(folder, { recursive: true, force: true });
        }
    });
});
