import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Executor } from "@genesiscz/utils/cli/executor";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { parseLoudness, probeMedia } from "./measure";
import { encodeMidi } from "./midi";
import { mixMusic, musicFilterGraph, placeMusic } from "./mix";
import { publishAudio, runAudio, withMusicSignal } from "./process";
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

    test("ends a held pitch before retriggering it on the same channel", () => {
        const midi = encodeMidi({
            ...minimal,
            parts: [
                {
                    ...minimal.parts[0],
                    notes: [
                        { at: 0, duration: 1.5, midi: 60, velocity: 90 },
                        { at: 1, duration: 1.5, midi: 60, velocity: 90 },
                    ],
                },
            ],
        });
        expect(midi.includes(Buffer.from([0x87, 0x40, 0x80, 60, 0, 0, 0x90, 60, 90]))).toBe(true);
    });

    /** The note events of every track, in order: [tick, "on" | "off", pitch]. The encoder writes no running status. */
    function noteEvents(midi: Buffer): Array<[number, "on" | "off", number]> {
        const events: Array<[number, "on" | "off", number]> = [];
        let at = 14;

        const varlen = (): number => {
            let value = 0;
            for (;;) {
                const byte = midi[at++] ?? 0;
                value = (value << 7) | (byte & 0x7f);
                if ((byte & 0x80) === 0) {
                    return value;
                }
            }
        };

        while (at < midi.length) {
            const end = at + 8 + midi.readUInt32BE(at + 4);
            at += 8;
            let tick = 0;
            while (at < end) {
                tick += varlen();
                const status = midi[at++] ?? 0;
                if (status === 0xff) {
                    at++;
                    const length = varlen();
                    at += length;
                } else if ((status & 0xf0) === 0xc0) {
                    at += 1;
                } else {
                    const pitch = midi[at] ?? 0;
                    if ((status & 0xf0) === 0x90 || (status & 0xf0) === 0x80) {
                        events.push([tick, (status & 0xf0) === 0x90 ? "on" : "off", pitch]);
                    }
                    at += 2;
                }
            }
        }

        return events;
    }

    test("same-pitch notes on one tick each get a Note Off after their Note On, never on its tick before it", () => {
        for (const starts of [
            [0.5, 0.5],
            [0.5, 0.5001],
        ]) {
            const events = noteEvents(
                encodeMidi({
                    ...minimal,
                    parts: [
                        {
                            ...minimal.parts[0],
                            notes: starts.map((at) => ({ at, duration: 1, midi: 60, velocity: 90 })),
                        },
                    ],
                })
            );
            let held = 0;

            for (const [, kind] of events) {
                held += kind === "on" ? 1 : -1;
                expect(held).toBeGreaterThanOrEqual(0);
            }

            expect(held).toBe(0);
            expect(events.map(([, kind]) => kind)).toEqual(["on", "on", "off", "off"]);
            expect(events.filter(([, kind]) => kind === "off").every(([tick]) => tick > events[0]![0])).toBe(true);
        }
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

    test("percussion parts retain independent volume and pan controllers", () => {
        const part = minimal.parts[0];
        const midi = encodeMidi({
            ...minimal,
            parts: [
                { ...part, name: "kick", percussion: true, volume: 1, pan: 0 },
                { ...part, name: "snare", percussion: true, volume: 127, pan: 127 },
            ],
        });
        expect(midi.includes(Buffer.from([0xb9, 7, 1]))).toBe(true);
        expect(midi.includes(Buffer.from([0xb0, 7, 127]))).toBe(true);
        expect(midi.includes(Buffer.from([0xb9, 10, 0]))).toBe(true);
        expect(midi.includes(Buffer.from([0xb0, 10, 127]))).toBe(true);
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
    test("media duration follows the selected picture rather than a longer audio tail", async () => {
        const exec = spyOn(Executor.prototype, "exec").mockResolvedValue({
            success: true,
            exitCode: 0,
            stderr: "",
            stdout: '{"streams":[{"codec_type":"video","duration":"1"},{"codec_type":"audio","duration":"2"}],"format":{"duration":"2"}}',
        });
        try {
            expect(await probeMedia("fixture.mp4")).toEqual({ seconds: 1, video: true, audio: true });
        } finally {
            exec.mockRestore();
        }
    });

    test("refuses an unknown picture duration instead of using an audio tail", async () => {
        const exec = spyOn(Executor.prototype, "exec").mockResolvedValue({
            success: true,
            exitCode: 0,
            stderr: "",
            stdout: '{"streams":[{"codec_type":"video","duration":"N/A"},{"codec_type":"audio","duration":"2"}],"format":{"duration":"2"}}',
        });
        try {
            await expect(probeMedia("fixture.mkv")).rejects.toThrow("video stream duration");
            exec.mockResolvedValue({
                success: true,
                exitCode: 0,
                stderr: "",
                stdout: '{"streams":[{"codec_type":"audio"}],"format":{"duration":"2"}}',
            });
            expect(await probeMedia("fixture.wav")).toEqual({ seconds: 2, video: false, audio: true });
        } finally {
            exec.mockRestore();
        }
    });

    test("cancellation stops an active child before it is released normally", async () => {
        const folder = await mkdtemp(join(tmpdir(), "music-cancel-child-"));
        const ready = join(folder, "ready");
        const release = join(folder, "release");
        const controller = new AbortController();
        const reason = new Error("stop music");
        const script = `import { watch, writeFileSync, existsSync } from "node:fs";
            import { join } from "node:path";
            const folder = process.argv[1];
            const watcher = watch(folder, () => {
                if (existsSync(join(folder, "release"))) { watcher.close(); process.exit(0); }
            });
            setTimeout(() => process.exit(0), 10000);
            writeFileSync(join(folder, "ready"), "ready");`;
        const outcome = withMusicSignal({
            signal: controller.signal,
            run: () => runAudio([process.execPath, "-e", script, folder]),
        }).then(
            () => undefined,
            (error: unknown) => error
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            expect(await waitForPath(ready, { timeoutMs: 5000 })).toBe(true);
            controller.abort(reason);
            const completed = await Promise.race([
                outcome,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("audio child ignored cancellation")), 3000);
                }),
            ]);
            expect(completed).toBe(reason);
        } finally {
            clearTimeout(timer);
            await writeFile(release, "release");
            await outcome;
            await rm(folder, { recursive: true, force: true });
        }
    });

    test("cancellation between preparation and publication preserves an existing output", async () => {
        const folder = await mkdtemp(join(tmpdir(), "music-cancel-publish-"));
        const output = join(folder, "out.wav");
        const controller = new AbortController();
        try {
            await writeFile(output, "old");
            await expect(
                withMusicSignal({
                    signal: controller.signal,
                    run: () =>
                        publishAudio({
                            output,
                            overwrite: true,
                            prepare: async (temporary) => {
                                await writeFile(temporary, "new");
                                controller.abort(new Error("stop before publication"));
                            },
                        }),
                })
            ).rejects.toThrow("stop before publication");
            expect(await readFile(output, "utf8")).toBe("old");
            expect(await readdir(folder)).toEqual(["out.wav"]);
        } finally {
            await rm(folder, { recursive: true, force: true });
        }
    });

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
