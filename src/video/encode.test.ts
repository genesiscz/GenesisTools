import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBatches } from "@genesiscz/utils/rm";
import type { MediaFacts } from "@genesiscz/utils/video/media-facts";
import { findEncoder, judgeOutput, skipReason, type VideoEncoder } from "@genesiscz/utils/video/reencode";
import { encodeVideos, isEarlierOutput, siblingOutput } from "./encode";

const encoder = findEncoder("hevc") as VideoEncoder;

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

describe("names", () => {
    test("the output sits beside the input and is not taken for an input", () => {
        const output = siblingOutput({ input: "/clips/a.mov", encoder });
        expect(output).toBe("/clips/a.hevc.mov");
        expect(isEarlierOutput({ input: output, encoder })).toBe(true);
        expect(isEarlierOutput({ input: "/clips/a.mov", encoder })).toBe(false);
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
            const dir = mkdtempSync(join(tmpdir(), "video-encode-"));
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

            expect(row.status).toBe("kept");
            expect(row.kept).toBe(true);
            expect(statSync(clip).size).toBeLessThan(before * 0.75);
            expect(existsSync(join(dir, "clip.hevc-tmp.mp4"))).toBe(false);
            expect(row.trashBatch).not.toBeNull();

            const batch = listBatches().find((candidate) => candidate.id === row.trashBatch);
            expect(batch?.items[0]?.original).toBe(clip);
            expect(existsSync(batch?.items[0]?.stored ?? "")).toBe(true);
        },
        60_000
    );
});
