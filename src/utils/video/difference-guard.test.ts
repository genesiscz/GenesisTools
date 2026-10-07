import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareImagePixels } from "@genesiscz/utils/image/difference";
import type { DecodedRgba } from "@genesiscz/utils/image/raster";
import { skip } from "@genesiscz/utils/test/skip";
import { FrameDifferenceGuard, frameDifferenceSummary } from "./difference-guard";
import { prepareVideoEvidence } from "./evidence";
import { LatestPreparation } from "./preparation";
import { runVideoCommand } from "./process";
import { locateVideoSamples, planVideoSamples, secondsToMicroseconds } from "./sampling";

function pixels(changed: number): DecodedRgba {
    const data = new Uint8ClampedArray(10 * 4);
    for (let i = 0; i < 10; i++) {
        data.set(i < changed ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    }

    return { width: 10, height: 1, data };
}

describe("image comparison and video difference guard", () => {
    it("returns exact changed pixel counts and an optional highlighted buffer", () => {
        const result = compareImagePixels({ a: pixels(0), b: pixels(3), includeDiff: true });
        expect(result.mismatchedPixels).toBe(3);
        expect(result.totalPixels).toBe(10);
        expect(result.differencePct).toBe(30);
        expect(result.similarity).toBe(0.7);
        expect(result.diff?.length).toBe(40);
        expect(compareImagePixels({ a: pixels(0), b: pixels(0) }).diff).toBeUndefined();
    });

    it("keeps the first and equal-threshold samples, compares gradual changes to the last kept frame", () => {
        const guard = new FrameDifferenceGuard({ minimumDifferencePct: 30 });
        const decisions = [0, 1, 2, 3, 5, 7].map((n, index) => guard.consider({ id: String(index), image: pixels(n) }));
        expect(decisions.map((d) => d.kept)).toEqual([true, false, false, true, false, true]);
        expect(decisions.map((d) => d.comparedToId)).toEqual([null, "0", "0", "0", "3", "3"]);
        expect(decisions.map((d) => d.differencePct)).toEqual([null, 10, 20, 30, 20, 40]);
    });

    it("keeps identical frames when filtering is disabled at zero", () => {
        const guard = new FrameDifferenceGuard({ minimumDifferencePct: 0 });
        expect(guard.consider({ id: "a", image: pixels(0) }).kept).toBe(true);
        expect(guard.consider({ id: "b", image: pixels(0) }).kept).toBe(true);
    });

    it("at 100 keeps only wholly changed frames after the forced first", () => {
        const guard = new FrameDifferenceGuard({ minimumDifferencePct: 100 });
        expect([0, 9, 10].map((n) => guard.consider({ id: String(n), image: pixels(n) }).kept)).toEqual([
            true,
            false,
            true,
        ]);
    });

    it("does not let reuse of a decoder buffer mutate the kept baseline", () => {
        const guard = new FrameDifferenceGuard({ minimumDifferencePct: 30 });
        const reused = pixels(0);
        guard.consider({ id: "a", image: reused });
        reused.data.set(pixels(3).data);
        expect(guard.consider({ id: "b", image: reused }).differencePct).toBe(30);
    });

    it("summarizes kept frames into partial sheets without padding", () => {
        const decisions = Array.from({ length: 28 }, (_, index) => ({
            id: String(index),
            kept: index < 25,
            differencePct: 10,
            comparedToId: "first",
        }));
        expect(frameDifferenceSummary({ decisions, framesPerImage: 16 })).toEqual({
            candidates: 28,
            kept: 25,
            skipped: 3,
            images: 2,
            lastImageFrames: 9,
        });
        expect(frameDifferenceSummary({ decisions: [], framesPerImage: 4 })).toEqual({
            candidates: 0,
            kept: 0,
            skipped: 0,
            images: 0,
            lastImageFrames: 0,
        });
    });

    it("rejects invalid thresholds, layouts, and dimension changes", () => {
        for (const n of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => new FrameDifferenceGuard({ minimumDifferencePct: n })).toThrow();
        }

        expect(() => compareImagePixels({ a: pixels(0), b: pixels(0), sensitivity: 2 })).toThrow();
        expect(() => compareImagePixels({ a: pixels(0), b: { ...pixels(0), width: 5, height: 2 } })).toThrow();
        expect(() =>
            compareImagePixels({ a: pixels(0), b: { ...pixels(0), data: new Uint8ClampedArray(0) } })
        ).toThrow();
        expect(() => frameDifferenceSummary({ decisions: [], framesPerImage: 3 })).toThrow();
    });
});

describe("video sample planning and preparation ownership", () => {
    it("plans exact fractional durations and partially filled sheets", () => {
        const plan = planVideoSamples({ durationUs: secondsToMicroseconds("12.4"), fps: 2, framesPerImage: 16 });
        expect(plan.candidates).toBe(25);
        expect(plan.images).toBe(2);
        expect(plan.lastImageFrames).toBe(9);
        expect(plan.timestampsUs.at(-1)).toBe(12_000_000);
        expect(
            planVideoSamples({ durationUs: secondsToMicroseconds("5.000000"), fps: 1, framesPerImage: 4 }).candidates
        ).toBe(5);
        expect(
            planVideoSamples({ durationUs: secondsToMicroseconds("5.0000001"), fps: 1, framesPerImage: 4 }).candidates
        ).toBe(6);
        expect(planVideoSamples({ durationUs: 12_400_000, fps: 4, framesPerImage: 8 }).lastImageFrames).toBe(2);
    });

    it("retains actual VFR source times independently from requested sample times", () => {
        expect(
            locateVideoSamples({
                requestedUs: [0, 250_000, 500_000, 750_000],
                sourceUs: [0, 120_000, 480_000, 700_000],
            })
        ).toEqual([
            { requestedUs: 0, actualUs: 0, sourceIndex: 0 },
            { requestedUs: 250_000, actualUs: 120_000, sourceIndex: 1 },
            { requestedUs: 500_000, actualUs: 480_000, sourceIndex: 2 },
            { requestedUs: 750_000, actualUs: 700_000, sourceIndex: 3 },
        ]);
        expect(() => locateVideoSamples({ requestedUs: [0], sourceUs: [] })).toThrow();
        expect(() => locateVideoSamples({ requestedUs: [0], sourceUs: [10, 5] })).toThrow();
    });

    it("rejects invalid sampling inputs instead of silently reducing density", () => {
        for (const fps of [0, 5, Number.NaN]) {
            expect(() => planVideoSamples({ durationUs: 1_000_000, fps, framesPerImage: 4 })).toThrow();
        }
        expect(() => planVideoSamples({ durationUs: 601_000_000, fps: 1, framesPerImage: 4 })).toThrow();
        expect(() => secondsToMicroseconds("NaN")).toThrow();
    });

    it("waits for cancellation cleanup and publishes only the latest generation", async () => {
        const jobs = new LatestPreparation<string>();
        let release: (() => void) | undefined;
        let started: (() => void) | undefined;
        const start = new Promise<void>((resolve) => {
            started = resolve;
        });
        const order: string[] = [];
        const old = jobs.request(async (signal) => {
            started?.();
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            expect(signal.aborted).toBe(true);
            order.push("old-cleaned");
            return "obsolete";
        });
        await start;
        const skipped = jobs.request(async () => {
            order.push("skipped");
            return "skipped";
        });
        const latest = jobs.request(async () => {
            order.push("latest");
            return "current";
        });
        release?.();
        expect(await old).toBeNull();
        expect(await skipped).toBeNull();
        expect((await latest)?.value).toBe("current");
        expect(order).toEqual(["old-cleaned", "latest"]);
    });
});

describe.skipIf(skip.integration)("real local video evidence", () => {
    it("decodes silent video, rotation, difference reduction and cleans cancelled generations", async () => {
        const root = await mkdtemp(join(tmpdir(), "gt-video-test-"));
        const source = join(root, "source.mp4");
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=red:size=128x80:rate=4:duration=1.25",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                source,
            ],
        });
        const outputRoot = join(root, "evidence");
        const all = await prepareVideoEvidence({
            input: source,
            outputRoot,
            settings: { fps: 4, framesPerImage: 4, minimumDifferencePct: 0 },
        });
        expect(all.counts).toEqual({ candidates: 5, kept: 5, skipped: 0, images: 2, lastImageFrames: 1 });
        expect(all.frames.map((frame) => frame.actualUs)).toEqual([0, 250000, 500000, 750000, 1000000]);
        const reduced = await prepareVideoEvidence({
            input: source,
            outputRoot,
            settings: { fps: 4, framesPerImage: 4, minimumDifferencePct: 1 },
        });
        expect(reduced.counts.kept).toBe(1);
        expect(reduced.counts.skipped).toBe(4);
        const rotatedPath = join(root, "rotated.mp4");
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-display_rotation:v:0",
                "90",
                "-i",
                source,
                "-c",
                "copy",
                rotatedPath,
            ],
        });
        const rotated = await prepareVideoEvidence({
            input: rotatedPath,
            outputRoot,
            settings: { fps: 1, framesPerImage: 4, minimumDifferencePct: 0 },
        });
        expect(rotated.source.displayWidth).toBe(80);
        expect(rotated.source.displayHeight).toBe(128);
        const before = (await readdir(outputRoot)).sort();
        const controller = new AbortController();
        await expect(
            prepareVideoEvidence({
                input: source,
                outputRoot,
                signal: controller.signal,
                settings: { fps: 4, framesPerImage: 4, minimumDifferencePct: 0 },
                progress: (event) => {
                    if (event.phase === "comparing") {
                        controller.abort();
                    }
                },
            })
        ).rejects.toThrow();
        expect((await readdir(outputRoot)).sort()).toEqual(before);
    }, 30_000);
});
