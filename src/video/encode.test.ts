import { afterAll, describe, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
    defaultRmConfig,
    identityOf,
    listBatches,
    RmPartialMoveError,
    restoreBatch,
    type TrashBatch,
} from "@genesiscz/utils/rm";
import { type MediaFacts, NotMediaError, readMediaFacts } from "@genesiscz/utils/video/media-facts";
import { runVideoCommand, VideoCommandExitError } from "@genesiscz/utils/video/process";
import {
    decodeErrors,
    encodeArgs,
    ffmpegCommand,
    findEncoder,
    judgeOutput,
    skipReason,
    type VideoEncoder,
} from "@genesiscz/utils/video/reencode";
import {
    collectInputs,
    type EncodeOptions,
    type EncodeRow,
    type EncodeStatus,
    encodeVideos,
    exitCodeFor,
    installVerified,
    isEarlierOutput,
    makeStaging,
    type PlannedReplace,
    planReplaceWithRm,
    probeFailureRow,
    ReplaceInstallError,
    replaceDecision,
    siblingOutput,
    snapshotSource,
    sourceChange,
    undoCommand,
} from "./encode";

const encoder = findEncoder("hevc") as VideoEncoder;
const madeDirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "video-encode-"));
    madeDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of madeDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function facts(patch: Partial<MediaFacts> = {}): MediaFacts {
    return {
        path: "/clips/a.mp4",
        bytes: 1000,
        durationSec: 10,
        streams: [
            { type: "video", codec: "h264", attachedPicture: false },
            { type: "audio", codec: "aac", attachedPicture: false },
        ],
        ...patch,
    };
}

const hevcOutput = facts({
    bytes: 500,
    streams: [
        { type: "video", codec: "hevc", attachedPicture: false },
        { type: "audio", codec: "aac", attachedPicture: false },
    ],
});

function judge(patch: Partial<Parameters<typeof judgeOutput>[0]> = {}) {
    return judgeOutput({
        input: facts(),
        output: hevcOutput,
        encoder,
        minSavingPct: 25,
        decodeErrors: "",
        ...patch,
    });
}

describe("skipReason", () => {
    test("an H.264 file with audio is a candidate", () => {
        expect(skipReason({ facts: facts(), encoder })).toBeNull();
    });

    test("skips HEVC, data tracks and non-video files", () => {
        const hevc = facts({ streams: [{ type: "video", codec: "hevc", attachedPicture: false }] });
        const mebx = facts({
            streams: [
                { type: "video", codec: "h264", attachedPicture: false },
                { type: "data", codec: "none", attachedPicture: false },
            ],
        });
        const music = facts({
            streams: [
                { type: "audio", codec: "mp3", attachedPicture: false },
                { type: "video", codec: "mjpeg", attachedPicture: true },
            ],
        });

        expect(skipReason({ facts: hevc, encoder })).toBe("already hevc");
        expect(skipReason({ facts: mebx, encoder })).toContain("data track");
        expect(skipReason({ facts: music, encoder })).toContain("not a video");
    });

    test("skips every stream the encode does not carry over, and keeps a file with several audio tracks", () => {
        const h264 = { type: "video", codec: "h264", attachedPicture: false };
        const aac = { type: "audio", codec: "aac", attachedPicture: false };
        const withStream = (stream: MediaFacts["streams"][number]) => facts({ streams: [h264, aac, stream] });

        expect(
            skipReason({ facts: withStream({ type: "subtitle", codec: "mov_text", attachedPicture: false }), encoder })
        ).toBe("has a subtitle track (mov_text) that a re-encode would drop");
        expect(skipReason({ facts: withStream({ ...h264, codec: "mpeg4" }), encoder })).toBe(
            "has a second video track (mpeg4) that a re-encode would drop"
        );
        expect(
            skipReason({ facts: withStream({ type: "video", codec: "mjpeg", attachedPicture: true }), encoder })
        ).toBe("has a cover picture (mjpeg) that a re-encode would drop");
        expect(
            skipReason({ facts: withStream({ type: "attachment", codec: "ttf", attachedPicture: false }), encoder })
        ).toBe("has an attachment track (ttf) that a re-encode would drop");
        expect(skipReason({ facts: facts({ streams: [h264, aac, { ...aac, codec: "ac3" }] }), encoder })).toBeNull();
    });
});

describe("judgeOutput", () => {
    test("keeps a verified, smaller output", () => {
        expect(judge().keep).toBe(true);
    });

    test("discards each failed check and says why", () => {
        expect(judge({ output: { ...hevcOutput, bytes: 800 } }).reason).toContain("only 20.0% smaller");
        expect(judge({ output: { ...hevcOutput, durationSec: 9.2 } }).reason).toContain("duration differs");
        expect(judge({ output: { ...hevcOutput, durationSec: 10.4 } }).keep).toBe(true);
        expect(judge({ output: { ...hevcOutput, durationSec: null } }).keep).toBe(false);
        expect(judge({ decodeErrors: "error while decoding" }).reason).toContain("does not decode");

        const notHevc = { ...hevcOutput, streams: [{ type: "video", codec: "h264", attachedPicture: false }] };
        expect(judge({ output: notHevc }).reason).toContain("is not hevc");

        const noAudio = { ...hevcOutput, streams: [hevcOutput.streams[0]] };
        expect(judge({ output: noAudio }).reason).toContain("lost its audio");

        const twoTracks = facts({
            streams: [...facts().streams, { type: "audio", codec: "ac3", attachedPicture: false }],
        });
        expect(judge({ input: twoTracks }).reason).toBe("the output has 1 of the input's 2 audio tracks");
        expect(
            judge({
                input: twoTracks,
                output: { ...hevcOutput, streams: [...hevcOutput.streams, twoTracks.streams[2]] },
            }).keep
        ).toBe(true);
    });

    test("a silent input needs no audio in the output", () => {
        const silentIn = facts({ streams: [{ type: "video", codec: "h264", attachedPicture: false }] });
        const silentOut = { ...hevcOutput, streams: [hevcOutput.streams[0]] };
        expect(judge({ input: silentIn, output: silentOut }).keep).toBe(true);
    });
});

describe("replaceDecision", () => {
    test("an agent keeps the result beside a file the rules mark ask", () => {
        const decision = replaceDecision({ verdict: "ask", reason: "no rule allows it", isInAgent: true });
        expect(decision.kind).toBe("beside");
    });

    test("a person replaces an ask file, and anyone replaces an allowed one", () => {
        expect(replaceDecision({ verdict: "ask", reason: "x", isInAgent: false }).kind).toBe("replace");
        expect(replaceDecision({ verdict: "allow", reason: "x", isInAgent: true }).kind).toBe("replace");
    });

    test("deny stops a person and an agent", () => {
        expect(replaceDecision({ verdict: "deny", reason: "x", isInAgent: false }).kind).toBe("refuse");
        expect(replaceDecision({ verdict: "deny", reason: "x", isInAgent: true }).kind).toBe("refuse");
    });
});

describe("names", () => {
    test("the output sits beside the input and is not taken for an input", () => {
        const output = siblingOutput({ input: "/clips/a.mov", encoder });
        expect(output).toBe("/clips/a.hevc.mov");
        expect(isEarlierOutput({ input: output, encoder })).toBe(true);
        expect(isEarlierOutput({ input: "/clips/a.mov", encoder })).toBe(false);
    });
});

describe("encodeArgs", () => {
    test("every ffmpeg runs under nice; the encode never overwrites and maps the playable video, not a cover", () => {
        expect(ffmpegCommand(["-hide_banner", "-encoders"])).toEqual([
            "nice",
            "-n",
            "10",
            "ffmpeg",
            "-hide_banner",
            "-encoders",
        ]);

        const args = encodeArgs({ encoder, input: "/clips/a.mp4", output: "/clips/out.mp4", quality: 58 });
        const ffmpeg = args.slice(4);
        expect(args.slice(0, 4)).toEqual(["nice", "-n", "10", "ffmpeg"]);
        expect(ffmpeg).toContain("-n");
        expect(ffmpeg).not.toContain("-y");
        expect(ffmpeg[ffmpeg.indexOf("-map") + 1]).toBe("0:V:0");
    });
});

describe("makeStaging", () => {
    test("each run gets its own hidden folder beside the input, and the folder walk skips it", () => {
        const dir = tempDir();
        const clip = join(dir, "clip.mp4");
        writeFileSync(clip, "x");

        const first = makeStaging({ input: clip, encoder });
        const second = makeStaging({ input: clip, encoder });
        writeFileSync(first.file, "encoded");

        expect(first.dir).not.toBe(second.dir);
        expect(dirname(first.dir)).toBe(dir);
        expect(basename(first.dir).startsWith(".")).toBe(true);
        expect(collectInputs({ paths: [dir], encoder })).toEqual([clip]);
    });
});

describe("exitCodeFor", () => {
    function row(status: EncodeStatus): EncodeRow {
        return {
            input: "/clips/a.mp4",
            output: null,
            inputBytes: 1,
            outputBytes: null,
            saving: null,
            kept: false,
            status,
            reason: "",
            trashBatch: null,
            seconds: 0,
        };
    }

    test("a failed file fails the run; skips and discards do not", () => {
        expect(exitCodeFor([row("skipped"), row("discarded"), row("kept"), row("kept-beside")])).toBe(0);
        expect(exitCodeFor([row("kept"), row("failed")])).toBe(1);
    });
});

describe("installVerified", () => {
    const keptReason = "50.0% smaller";
    const originalTime = new Date("2024-01-02T03:04:05Z");

    function setup() {
        const dir = tempDir();
        const clip = join(dir, "clip.mp4");
        writeFileSync(clip, "original");
        utimesSync(clip, originalTime, originalTime);
        const staging = makeStaging({ input: clip, encoder });
        writeFileSync(staging.file, "encoded");
        return {
            clip,
            source: snapshotSource(clip),
            staged: staging.file,
            sibling: siblingOutput({ input: clip, encoder }),
            held: join(dir, "held"),
        };
    }

    function trashBatch(id: string): TrashBatch {
        return { id, createdAt: "", drainAfter: "", caller: null, items: [] };
    }

    // Every step that touches the trash throws unless the test opts in, so a guarded path that reaches it fails.
    function planned(patch: Partial<PlannedReplace> & Pick<PlannedReplace, "verdict" | "isInAgent" | "identity">) {
        return (): PlannedReplace => ({
            reason: "test rule",
            moveOriginal: () => {
                throw new Error("moveOriginal reached");
            },
            restore: () => {
                throw new Error("restore reached");
            },
            startDrainer: () => {
                throw new Error("startDrainer reached");
            },
            ...patch,
        });
    }

    function installError(run: () => unknown): ReplaceInstallError {
        try {
            run();
        } catch (error) {
            if (error instanceof ReplaceInstallError) {
                return error;
            }

            throw error;
        }

        throw new Error("the install did not fail");
    }

    test("without --replace the result takes the sibling name, and one that appeared meanwhile is never overwritten", () => {
        const first = setup();
        const noTrash = () => {
            throw new Error("planReplace reached");
        };
        const kept = installVerified({
            ...first,
            input: first.clip,
            encoder,
            replace: false,
            keptReason,
            planReplace: noTrash,
        });
        expect(kept).toEqual({ status: "kept", output: first.sibling, reason: keptReason, trashBatch: null });
        expect(readFileSync(first.sibling, "utf8")).toBe("encoded");
        expect(readFileSync(first.clip, "utf8")).toBe("original");

        const second = setup();
        writeFileSync(second.sibling, "another run");
        const taken = installVerified({
            ...second,
            input: second.clip,
            encoder,
            replace: false,
            keptReason,
            planReplace: noTrash,
        });
        expect(taken.status).toBe("discarded");
        expect(readFileSync(second.sibling, "utf8")).toBe("another run");
    });

    test("deny refuses before the trash move", () => {
        const { clip, source, staged } = setup();
        const planReplace = planned({ verdict: "deny", isInAgent: false, identity: source.identity });
        expect(() =>
            installVerified({ input: clip, source, staged, encoder, replace: true, keptReason, planReplace })
        ).toThrow("the trash rules refuse the original");
        expect(readFileSync(clip, "utf8")).toBe("original");
    });

    test("an agent keeps the result beside an ask original and never reaches the trash", () => {
        const { clip, source, staged, sibling } = setup();
        const planReplace = planned({ verdict: "ask", isInAgent: true, identity: source.identity });
        const result = installVerified({
            input: clip,
            source,
            staged,
            encoder,
            replace: true,
            keptReason,
            planReplace,
        });
        expect(result.status).toBe("kept-beside");
        expect(result.output).toBe(sibling);
        expect(result.trashBatch).toBeNull();
        expect(readFileSync(sibling, "utf8")).toBe("encoded");
        expect(readFileSync(clip, "utf8")).toBe("original");
    });

    test("allow moves the original, installs the result with the original's times, then starts the drainer", () => {
        const { clip, source, staged, held } = setup();
        const steps: string[] = [];
        const planReplace = planned({
            verdict: "allow",
            isInAgent: true,
            identity: source.identity,
            moveOriginal: () => {
                steps.push("move");
                renameSync(clip, held);
                return "batch-1";
            },
            startDrainer: () => {
                steps.push(`drain with ${readFileSync(clip, "utf8")} installed`);
            },
        });

        const result = installVerified({
            input: clip,
            source,
            staged,
            encoder,
            replace: true,
            keptReason,
            planReplace,
        });
        expect(result).toEqual({ status: "kept", output: clip, reason: keptReason, trashBatch: "batch-1" });
        expect(steps).toEqual(["move", "drain with encoded installed"]);
        expect(statSync(clip).mtime.getTime()).toBe(originalTime.getTime());
        expect(readFileSync(held, "utf8")).toBe("original");
    });

    test("an original edited during the encode drops the result, with --replace before the trash and without it", () => {
        const replaced = setup();
        // Same size, so only the modification time tells the edit apart.
        writeFileSync(replaced.clip, "ORIGINAL");
        const planReplace = planned({ verdict: "allow", isInAgent: false, identity: replaced.source.identity });
        const result = installVerified({
            ...replaced,
            input: replaced.clip,
            encoder,
            replace: true,
            keptReason,
            planReplace,
        });
        expect(result.status).toBe("discarded");
        expect(result.reason).toBe("the original changed during the encode (it was modified); the result was dropped");
        expect(readFileSync(replaced.clip, "utf8")).toBe("ORIGINAL");

        const beside = setup();
        writeFileSync(beside.clip, "edited during the encode");
        const kept = installVerified({
            ...beside,
            input: beside.clip,
            encoder,
            replace: false,
            keptReason,
            planReplace: () => {
                throw new Error("planReplace reached");
            },
        });
        expect(kept.status).toBe("discarded");
        expect(existsSync(beside.sibling)).toBe(false);
    });

    test("another run's result at the original path is never trashed in place of the original", () => {
        const { clip, source, staged, held } = setup();
        renameSync(clip, held);
        writeFileSync(clip, "another run's result");
        // The rules judge whatever sits at the path now, and the move would be pinned to that.
        const planReplace = planned({ verdict: "allow", isInAgent: false, identity: identityOf(clip) });
        const result = installVerified({
            input: clip,
            source,
            staged,
            encoder,
            replace: true,
            keptReason,
            planReplace,
        });
        expect(result.reason).toContain("(another file took its path)");
        expect(readFileSync(clip, "utf8")).toBe("another run's result");
        expect(readFileSync(held, "utf8")).toBe("original");
    });

    test("a move pinned to another file than the encode read is refused, and a gone original is named", () => {
        const { clip, source, staged } = setup();
        const planReplace = planned({ verdict: "allow", isInAgent: false, identity: "0:0" });
        const result = installVerified({
            input: clip,
            source,
            staged,
            encoder,
            replace: true,
            keptReason,
            planReplace,
        });
        expect(result.reason).toContain("(the trash rules judged another file at its path)");
        expect(readFileSync(clip, "utf8")).toBe("original");

        rmSync(clip);
        expect(sourceChange({ source, path: clip })).toBe("it is gone");
    });

    test("a trash move that fails after the original moved puts it back, or names the batch when that fails", () => {
        const back = setup();
        const restored = installError(() =>
            installVerified({
                ...back,
                input: back.clip,
                encoder,
                replace: true,
                keptReason,
                planReplace: planned({
                    verdict: "allow",
                    isInAgent: false,
                    identity: back.source.identity,
                    moveOriginal: () => {
                        renameSync(back.clip, back.held);
                        throw new RmPartialMoveError(trashBatch("batch-1"), new Error("the ledger write failed"));
                    },
                    restore: (batch) => {
                        expect(batch).toBe("batch-1");
                        renameSync(back.held, back.clip);
                        return true;
                    },
                }),
            })
        );
        expect(restored.trashBatch).toBeNull();
        expect(restored.message).toBe(
            "the trash move failed after the original moved (the ledger write failed); the original is back"
        );
        expect(readFileSync(back.clip, "utf8")).toBe("original");
        expect(readFileSync(back.staged, "utf8")).toBe("encoded");

        const stuck = setup();
        const waiting = installError(() =>
            installVerified({
                ...stuck,
                input: stuck.clip,
                encoder,
                replace: true,
                keptReason,
                planReplace: planned({
                    verdict: "allow",
                    isInAgent: false,
                    identity: stuck.source.identity,
                    moveOriginal: () => {
                        renameSync(stuck.clip, stuck.held);
                        throw new RmPartialMoveError(trashBatch("batch-2"), new Error("the ledger write failed"));
                    },
                    restore: () => false,
                }),
            })
        );
        expect(waiting.trashBatch).toBe("batch-2");
        expect(waiting.message).toContain("the original waits in trash batch batch-2");
        expect(existsSync(stuck.clip)).toBe(false);
    });

    test("a move that throws before the original moved is a plain failure with nothing to put back", () => {
        const { clip, source, staged } = setup();
        const planReplace = planned({
            verdict: "allow",
            isInAgent: false,
            identity: source.identity,
            moveOriginal: () => {
                throw new Error("the trash is unwritable");
            },
        });
        expect(() =>
            installVerified({ input: clip, source, staged, encoder, replace: true, keptReason, planReplace })
        ).toThrow("the trash is unwritable");
        expect(readFileSync(clip, "utf8")).toBe("original");
    });

    test("a failed install puts the original back and reports no batch", () => {
        const { clip, source, staged, held } = setup();
        const planReplace = planned({
            verdict: "allow",
            isInAgent: false,
            identity: source.identity,
            moveOriginal: () => {
                renameSync(clip, held);
                rmSync(staged);
                return "batch-1";
            },
            restore: (batch) => {
                expect(batch).toBe("batch-1");
                renameSync(held, clip);
                return true;
            },
        });

        const error = installError(() =>
            installVerified({ input: clip, source, staged, encoder, replace: true, keptReason, planReplace })
        );
        expect(error.trashBatch).toBeNull();
        expect(error.message).toContain("the original is back");
        expect(readFileSync(clip, "utf8")).toBe("original");
    });

    test("a failed install whose restore fails keeps the batch, and the file at the original path is left alone", () => {
        const { clip, source, staged, held } = setup();
        const planReplace = planned({
            verdict: "allow",
            isInAgent: false,
            identity: source.identity,
            moveOriginal: () => {
                renameSync(clip, held);
                writeFileSync(clip, "appeared meanwhile");
                return "batch-1";
            },
            restore: () => false,
        });

        const error = installError(() =>
            installVerified({ input: clip, source, staged, encoder, replace: true, keptReason, planReplace })
        );
        expect(error.trashBatch).toBe("batch-1");
        expect(error.message).toContain("trash batch batch-1");
        expect(readFileSync(clip, "utf8")).toBe("appeared meanwhile");
        expect(readFileSync(held, "utf8")).toBe("original");
    });
});

function encodeOptions(patch: Partial<EncodeOptions> & Pick<EncodeOptions, "paths">): EncodeOptions {
    return { encoder, quality: 58, jobs: 1, minSavingPct: 25, replace: false, dryRun: false, ...patch };
}

describe("probe failures", () => {
    test("a process that exits non-zero judged its input; one that cannot start or is killed did not", async () => {
        const failure = (command: string[]) => runVideoCommand({ command }).catch((error: unknown) => error);

        const exited = await failure(["sh", "-c", "echo bad input >&2; exit 3"]);
        expect(exited).toBeInstanceOf(VideoCommandExitError);
        expect(exited).toMatchObject({ status: 3, message: "bad input\n" });

        // The child-deadline watchdog reports a failed exec as exit 127 and a signal as 128 + N.
        const missing = await failure(["gt-no-such-video-binary"]);
        expect(missing).toBeInstanceOf(Error);
        expect(missing).not.toBeInstanceOf(VideoCommandExitError);

        const killed = await failure(["sh", "-c", "kill -9 $$"]);
        expect(killed).toBeInstanceOf(Error);
        expect(killed).not.toBeInstanceOf(VideoCommandExitError);
    });

    test("a file ffprobe rejects is skipped; any other probe failure fails the row", () => {
        const notMedia = new NotMediaError("/clips/a.mp4", new VideoCommandExitError("Invalid data found", 1));
        expect(probeFailureRow({ input: "/clips/a.mp4", error: notMedia })).toEqual({
            status: "skipped",
            reason: "not a video (ffprobe cannot read it)",
        });
        expect(probeFailureRow({ input: "/clips/a.mp4", error: new Error("spawn ffprobe ENOENT") })).toEqual({
            status: "failed",
            reason: "the probe failed: spawn ffprobe ENOENT",
        });
    });

    test.skipIf(process.getuid?.() === 0)(
        "a file this process cannot read fails the run instead of passing as not a video",
        async () => {
            const clip = join(tempDir(), "locked.mp4");
            writeFileSync(clip, "x");
            chmodSync(clip, 0o000);

            try {
                await expect(readMediaFacts({ input: clip })).rejects.toThrow(/EACCES/);
                const rows = await encodeVideos(encodeOptions({ paths: [clip] }));
                expect(rows[0]?.status).toBe("failed");
                expect(rows[0]?.reason).toMatch(/^the probe failed: EACCES/);
                expect(exitCodeFor(rows)).toBe(1);
            } finally {
                chmodSync(clip, 0o600);
            }
        }
    );

    test.skipIf(Bun.which("ffprobe") === null)(
        "a file ffprobe reads and rejects is skipped as not a video",
        async () => {
            const clip = join(tempDir(), "notes.mp4");
            writeFileSync(clip, "plain text, not a video");

            await expect(readMediaFacts({ input: clip })).rejects.toBeInstanceOf(NotMediaError);
            const rows = await encodeVideos(encodeOptions({ paths: [clip] }));
            expect(rows[0]).toMatchObject({ status: "skipped", reason: "not a video (ffprobe cannot read it)" });
            expect(exitCodeFor(rows)).toBe(0);
        }
    );

    test("an input gone before its turn fails its own row, and every other row still comes back", async () => {
        const dir = tempDir();
        const first = join(dir, "first.txt");
        const gone = join(dir, "gone.mp4");
        writeFileSync(first, "not a container");
        writeFileSync(gone, "x");

        // The walk saw both files; the second goes while the first is in work, before its worker reads it.
        const pending = encodeVideos(encodeOptions({ paths: [first, gone] }));
        rmSync(gone);
        const rows = await pending;

        expect(rows.map((row) => row.status)).toEqual(["skipped", "failed"]);
        expect(rows[1]).toMatchObject({ input: gone, inputBytes: 0 });
        expect(rows[1]?.reason).toMatch(/^cannot read the input: ENOENT/);
        expect(exitCodeFor(rows)).toBe(1);
    });
});

/**
 * Two clips with two AAC tracks; in `damaged` the second track's packets after the first 40 are noise, so the
 * stream probe reads it as clean and only a decode of that track fails. Null when this ffmpeg cannot make them.
 */
function secondTrackFixture(): { clean: string; damaged: string } | null {
    if (Bun.which("ffmpeg") === null) {
        return null;
    }

    const dir = tempDir();
    const clean = join(dir, "clean.mkv");
    const damaged = join(dir, "damaged.mkv");
    const sources = [
        ["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=2"],
        ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
        ["-f", "lavfi", "-i", "sine=frequency=660:duration=2"],
    ].flat();
    const tracks = ["-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "mpeg4", "-c:a", "aac", "-shortest"];
    const made = Bun.spawnSync(["ffmpeg", "-v", "error", ...sources, ...tracks, "-fflags", "+bitexact", clean], {
        stderr: "pipe",
        env: process.env,
    });
    // From the 41st packet on, about every fourth byte of the second audio track is changed.
    const noise = "noise=amount=if(gt(n\\,40)\\,4\\,0)";
    const broken =
        made.exitCode === 0 &&
        Bun.spawnSync(["ffmpeg", "-v", "error", "-i", clean, "-map", "0", "-c", "copy", "-bsf:a:1", noise, damaged], {
            stderr: "pipe",
            env: process.env,
        }).exitCode === 0;
    return broken ? { clean, damaged } : null;
}

describe("decodeErrors", () => {
    const fixture = secondTrackFixture();

    test.skipIf(fixture === null)("decodes every audio track the encode kept, not only ffmpeg's pick", async () => {
        const software: VideoEncoder = { ...encoder, decodeArgs: [] };
        const clips = fixture ?? { clean: "", damaged: "" };

        expect(await decodeErrors({ encoder: software, path: clips.clean })).toBe("");
        expect(await decodeErrors({ encoder: software, path: clips.damaged })).toContain("aac");
    });
});

describe("undoCommand", () => {
    test("moves the result aside without writing over a sibling, and restores only after a real move", () => {
        const dir = tempDir();
        const clip = join(dir, "it's a clip.mp4");
        const sibling = siblingOutput({ input: clip, encoder });
        const command = undoCommand({ input: clip, encoder, restore: "touch restored" });
        writeFileSync(clip, "result");
        writeFileSync(sibling, "an earlier output");

        const blocked = Bun.spawnSync(["sh", "-c", command], { cwd: dir, stderr: "pipe", env: process.env });
        expect(blocked.exitCode).not.toBe(0);
        expect(readFileSync(sibling, "utf8")).toBe("an earlier output");
        expect(readFileSync(clip, "utf8")).toBe("result");
        expect(existsSync(join(dir, "restored"))).toBe(false);

        rmSync(sibling);
        const done = Bun.spawnSync(["sh", "-c", command], { cwd: dir, stderr: "pipe", env: process.env });
        expect(done.exitCode).toBe(0);
        expect(readFileSync(sibling, "utf8")).toBe("result");
        expect(existsSync(clip)).toBe(false);
        expect(existsSync(join(dir, "restored"))).toBe(true);
    });
});

function hardwareReady(): boolean {
    if (process.platform !== "darwin") {
        return false;
    }

    const result = Bun.spawnSync(["ffmpeg", "-hide_banner", "-encoders"], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });
    return result.exitCode === 0 && result.stdout.toString().includes("hevc_videotoolbox");
}

describe("encode with the hardware encoder", () => {
    test.skipIf(!hardwareReady())(
        "--replace keeps the HEVC file and puts the original in the trash",
        async () => {
            const dir = tempDir();
            const clip = join(dir, "clip.mp4");
            const made = Bun.spawnSync(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=1280x720:rate=30:duration=2,noise=alls=12:allf=t",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=2",
                    "-c:v",
                    "libx264",
                    "-b:v",
                    "6M",
                    "-c:a",
                    "aac",
                    "-shortest",
                    clip,
                ],
                { stderr: "pipe", env: process.env }
            );
            expect(made.exitCode).toBe(0);
            const before = statSync(clip).size;

            // An rm config of the test's own: the fixture folder is a trusted root, so the replace runs for an agent
            // too, the original goes to a trash inside the fixture (never the shared one), and no drainer starts.
            const trash = tempDir();
            const config = {
                ...defaultRmConfig(),
                trashRoot: join(trash, "GenesisTools", "rm"),
                roots: [{ path: dir, addedAt: new Date().toISOString(), via: "test" }],
            };
            const paths = { batchesDir: join(trash, "batches"), lockPath: join(trash, "drainer.lock") };
            let drainerStarts = 0;
            const startDrainer = () => {
                drainerStarts++;
            };

            const [row] = await encodeVideos(
                encodeOptions({
                    paths: [dir],
                    replace: true,
                    planReplace: (input) => planReplaceWithRm(input, { config, paths, startDrainer }),
                })
            );

            expect(row).toMatchObject({ status: "kept", kept: true, output: clip });
            expect(readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]);
            expect(statSync(clip).size).toBeLessThan(before * 0.75);
            expect(drainerStarts).toBe(1);

            const batch = listBatches(paths).find((candidate) => candidate.id === row.trashBatch);
            expect(batch?.items[0]?.original).toBe(clip);
            expect(batch?.items[0]?.stored.startsWith(realpathSync(config.trashRoot))).toBe(true);

            // The printed undo: the result moves aside, then the real restore puts the original back.
            const aside = Bun.spawnSync(["sh", "-c", undoCommand({ input: clip, encoder, restore: "true" })], {
                stderr: "pipe",
                env: process.env,
            });
            expect(aside.exitCode).toBe(0);
            expect(restoreBatch(row.trashBatch ?? "", { config, paths }).restored).toEqual([clip]);
            expect(statSync(clip).size).toBe(before);
            expect(statSync(siblingOutput({ input: clip, encoder })).size).toBeLessThan(before * 0.75);
        },
        60_000
    );
});
