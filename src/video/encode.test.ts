import { afterAll, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { listBatches } from "@genesiscz/utils/rm";
import type { MediaFacts } from "@genesiscz/utils/video/media-facts";
import {
    encodeArgs,
    ffmpegCommand,
    findEncoder,
    judgeOutput,
    skipReason,
    type VideoEncoder,
} from "@genesiscz/utils/video/reencode";
import {
    collectInputs,
    type EncodeRow,
    type EncodeStatus,
    encodeVideos,
    exitCodeFor,
    installVerified,
    isEarlierOutput,
    makeStaging,
    type PlannedReplace,
    ReplaceInstallError,
    replaceDecision,
    siblingOutput,
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
            staged: staging.file,
            sibling: siblingOutput({ input: clip, encoder }),
            held: join(dir, "held"),
        };
    }

    // Every step that touches the trash throws unless the test opts in, so a guarded path that reaches it fails.
    function planned(patch: Partial<PlannedReplace> & Pick<PlannedReplace, "verdict" | "isInAgent">) {
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
        const { clip, staged } = setup();
        const planReplace = planned({ verdict: "deny", isInAgent: false });
        expect(() => installVerified({ input: clip, staged, encoder, replace: true, keptReason, planReplace })).toThrow(
            "the trash rules refuse the original"
        );
        expect(readFileSync(clip, "utf8")).toBe("original");
    });

    test("an agent keeps the result beside an ask original and never reaches the trash", () => {
        const { clip, staged, sibling } = setup();
        const planReplace = planned({ verdict: "ask", isInAgent: true });
        const result = installVerified({ input: clip, staged, encoder, replace: true, keptReason, planReplace });
        expect(result.status).toBe("kept-beside");
        expect(result.output).toBe(sibling);
        expect(result.trashBatch).toBeNull();
        expect(readFileSync(sibling, "utf8")).toBe("encoded");
        expect(readFileSync(clip, "utf8")).toBe("original");
    });

    test("allow moves the original, installs the result with the original's times, then starts the drainer", () => {
        const { clip, staged, held } = setup();
        const steps: string[] = [];
        const planReplace = planned({
            verdict: "allow",
            isInAgent: true,
            moveOriginal: () => {
                steps.push("move");
                renameSync(clip, held);
                return "batch-1";
            },
            startDrainer: () => {
                steps.push(`drain with ${readFileSync(clip, "utf8")} installed`);
            },
        });

        const result = installVerified({ input: clip, staged, encoder, replace: true, keptReason, planReplace });
        expect(result).toEqual({ status: "kept", output: clip, reason: keptReason, trashBatch: "batch-1" });
        expect(steps).toEqual(["move", "drain with encoded installed"]);
        expect(statSync(clip).mtime.getTime()).toBe(originalTime.getTime());
        expect(readFileSync(held, "utf8")).toBe("original");
    });

    test("a failed install puts the original back and reports no batch", () => {
        const { clip, staged, held } = setup();
        const planReplace = planned({
            verdict: "allow",
            isInAgent: false,
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
            installVerified({ input: clip, staged, encoder, replace: true, keptReason, planReplace })
        );
        expect(error.trashBatch).toBeNull();
        expect(error.message).toContain("the original is back");
        expect(readFileSync(clip, "utf8")).toBe("original");
    });

    test("a failed install whose restore fails keeps the batch, and the file at the original path is left alone", () => {
        const { clip, staged, held } = setup();
        const planReplace = planned({
            verdict: "allow",
            isInAgent: false,
            moveOriginal: () => {
                renameSync(clip, held);
                writeFileSync(clip, "appeared meanwhile");
                return "batch-1";
            },
            restore: () => false,
        });

        const error = installError(() =>
            installVerified({ input: clip, staged, encoder, replace: true, keptReason, planReplace })
        );
        expect(error.trashBatch).toBe("batch-1");
        expect(error.message).toContain("trash batch batch-1");
        expect(readFileSync(clip, "utf8")).toBe("appeared meanwhile");
        expect(readFileSync(held, "utf8")).toBe("original");
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

            const [row] = await encodeVideos({
                paths: [dir],
                encoder,
                quality: 58,
                jobs: 1,
                minSavingPct: 25,
                replace: true,
                dryRun: false,
            });

            // The trash rules decide for the temp folder: an agent run gets "ask" and keeps the result beside the
            // original, a run the rules allow replaces it. Both outcomes must leave a clean, verified state.
            expect(row.kept).toBe(true);
            expect(readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]);

            if (row.status === "kept-beside") {
                expect(statSync(clip).size).toBe(before);
                expect(row.output).toBe(join(dir, "clip.hevc.mp4"));
                expect(statSync(join(dir, "clip.hevc.mp4")).size).toBeLessThan(before * 0.75);
                expect(row.trashBatch).toBeNull();
                return;
            }

            expect(row.status).toBe("kept");
            expect(statSync(clip).size).toBeLessThan(before * 0.75);
            expect(row.trashBatch).not.toBeNull();

            const batch = listBatches().find((candidate) => candidate.id === row.trashBatch);
            expect(batch?.items[0]?.original).toBe(clip);
            expect(existsSync(batch?.items[0]?.stored ?? "")).toBe(true);
        },
        60_000
    );
});
