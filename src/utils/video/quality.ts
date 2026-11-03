import { availableParallelism } from "node:os";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { readMediaFacts } from "./media-facts";
import { ffmpegCommand } from "./reencode";

/** One stretch of the video that a preview encodes and scores. */
export interface SampleWindow {
    /** `hardest` has the most video bytes per second in the source, `easiest` the fewest. */
    label: "hardest" | "median" | "easiest";
    startSec: number;
    durationSec: number;
    /** The source's own video bitrate inside the window. */
    sourceKbps: number;
    /** The source's video bytes inside the window, what a size ratio is taken against. */
    sourceBytes: number;
}

/** A video packet as ffprobe lists it: its presentation time and its size. */
export interface VideoPacket {
    ptsSec: number;
    bytes: number;
}

/** Windows never start in the first or end in the last 5%: intros, outros and black frames tell nothing. */
const EDGE_SHARE = 0.05;

/**
 * The hardest, the median and the easiest window of `windowSec` by the source's own bitrate, which the source encoder
 * spent where the picture was hard. A video too short for three distinct windows gives fewer.
 */
export function pickSampleWindows({
    packets,
    durationSec,
    windowSec,
}: {
    packets: VideoPacket[];
    durationSec: number;
    windowSec: number;
}): SampleWindow[] {
    const edge = durationSec > windowSec * 4 ? durationSec * EDGE_SHARE : 0;
    const first = edge;
    const last = durationSec - edge - windowSec;

    if (last < first) {
        const bytes = packets.reduce((sum, packet) => sum + packet.bytes, 0);
        const length = Math.max(0.1, durationSec);
        return [
            {
                label: "median",
                startSec: 0,
                durationSec: length,
                sourceBytes: bytes,
                sourceKbps: (bytes * 8) / length / 1000,
            },
        ];
    }

    const count = Math.floor((last - first) / windowSec) + 1;
    const buckets = new Array<number>(count).fill(0);

    for (const packet of packets) {
        const index = Math.floor((packet.ptsSec - first) / windowSec);

        if (index >= 0 && index < count) {
            buckets[index] += packet.bytes;
        }
    }

    const order = buckets.map((bytes, index) => ({ bytes, index })).sort((a, b) => a.bytes - b.bytes);
    const chosen: { label: SampleWindow["label"]; index: number; bytes: number }[] = [];

    for (const [label, pick] of [
        ["hardest", order[order.length - 1]],
        ["median", order[Math.floor(order.length / 2)]],
        ["easiest", order[0]],
    ] as const) {
        if (!chosen.some((window) => window.index === pick.index)) {
            chosen.push({ label, index: pick.index, bytes: pick.bytes });
        }
    }

    return chosen.map(({ label, index, bytes }) => ({
        label,
        startSec: first + index * windowSec,
        durationSec: windowSec,
        sourceBytes: bytes,
        sourceKbps: (bytes * 8) / windowSec / 1000,
    }));
}

/** Every packet of the first video stream; reads the whole file once, without decoding it. */
export async function readVideoPackets({
    input,
    signal,
}: {
    input: string;
    signal?: AbortSignal;
}): Promise<VideoPacket[]> {
    const result = await boundedCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time,size",
            "-of",
            "csv=p=0",
            input,
        ],
        timeoutMs: 10 * 60_000,
        maxBufferBytes: 64 * 1024 * 1024,
        signal,
    });

    if (result.error || result.status !== 0) {
        throw new Error(
            `ffprobe could not list the packets of ${input}: ${result.error?.message ?? result.stderr.trim()}`
        );
    }

    const packets: VideoPacket[] = [];

    for (const line of result.stdout.split("\n")) {
        const [pts, size] = line.split(",");
        const ptsSec = Number(pts);
        const bytes = Number(size);

        if (pts && Number.isFinite(ptsSec) && Number.isFinite(bytes)) {
            packets.push({ ptsSec, bytes });
        }
    }

    logger.debug({ input, packets: packets.length }, "Read the video packets");
    return packets;
}

/**
 * Cuts one window of the source's video as a lossless file. Every candidate is encoded from it and scored against it,
 * so the frames line up exactly and no candidate pays for a second lossy step.
 */
export async function cutReference({
    input,
    window,
    output,
    signal,
}: {
    input: string;
    window: Pick<SampleWindow, "startSec" | "durationSec">;
    output: string;
    signal?: AbortSignal;
}): Promise<void> {
    const result = await boundedCommand({
        command: ffmpegCommand([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-ss",
            window.startSec.toFixed(3),
            "-t",
            window.durationSec.toFixed(3),
            "-i",
            input,
            "-map",
            "0:v:0",
            "-c:v",
            "libx264",
            "-qp",
            "0",
            "-preset",
            "ultrafast",
            "-an",
            output,
        ]),
        timeoutMs: 10 * 60_000,
        signal,
    });

    if (result.error || result.status !== 0) {
        throw new Error(`ffmpeg could not cut the reference window: ${result.error?.message ?? result.stderr.trim()}`);
    }
}

export interface QualityScore {
    /** Netflix VMAF, 0 to 100; null when this ffmpeg has no libvmaf. */
    vmaf: number | null;
    /** SSIM over all planes, 0 to 1. */
    ssim: number;
}

let vmafAvailable: Promise<boolean> | undefined;

/** Whether this ffmpeg has the libvmaf filter; asked once per process. */
export function hasVmaf(): Promise<boolean> {
    vmafAvailable ??= boundedCommand({ command: ["ffmpeg", "-hide_banner", "-filters"], timeoutMs: 30_000 }).then(
        (result) => result.status === 0 && /\blibvmaf\b/.test(result.stdout)
    );
    return vmafAvailable;
}

/**
 * Scores `distorted` against `reference`. The distorted picture is scaled to the reference size with bicubic, the same
 * scaler for every candidate, so a candidate encoded at a lower height is judged on what a player would show.
 * `distortedWindow` seeks into a full-length file (the final encode) to the reference's stretch.
 */
export async function measureQuality({
    distorted,
    reference,
    distortedWindow,
    signal,
}: {
    distorted: string;
    reference: string;
    distortedWindow?: Pick<SampleWindow, "startSec" | "durationSec">;
    signal?: AbortSignal;
}): Promise<QualityScore> {
    const ref = (await readMediaFacts({ input: reference, signal })).streams.find((stream) => stream.type === "video");

    if (!ref?.width || !ref.height) {
        throw new Error(`ffprobe reports no picture size for ${reference}`);
    }

    const vmaf = await hasVmaf();
    const scale = `[0:v]setpts=PTS-STARTPTS,scale=${ref.width}:${ref.height}:flags=bicubic,format=yuv420p[d]`;
    const refChain = vmaf
        ? "[1:v]setpts=PTS-STARTPTS,format=yuv420p,split=2[r1][r2]"
        : "[1:v]setpts=PTS-STARTPTS,format=yuv420p[r2]";
    // libvmaf passes the distorted frames through, so ssim compares them next on the same graph.
    const compare = vmaf
        ? `[d][r1]libvmaf=n_threads=${Math.max(1, availableParallelism() - 2)}[v];[v][r2]ssim`
        : "[d][r2]ssim";
    const seek = distortedWindow
        ? ["-ss", distortedWindow.startSec.toFixed(3), "-t", distortedWindow.durationSec.toFixed(3)]
        : [];
    const result = await boundedCommand({
        command: ffmpegCommand([
            "-hide_banner",
            "-nostdin",
            "-nostats",
            "-v",
            "info",
            ...seek,
            "-i",
            distorted,
            "-i",
            reference,
            "-filter_complex",
            `${scale};${refChain};${compare}`,
            "-f",
            "null",
            "-",
        ]),
        timeoutMs: 20 * 60_000,
        signal,
    });

    const ssimMatch = /SSIM .*All:([0-9.]+)/.exec(result.stderr);
    const vmafMatch = /VMAF score: ([0-9.]+)/.exec(result.stderr);

    if (result.error || result.status !== 0 || !ssimMatch) {
        throw new Error(
            `ffmpeg could not score ${distorted}: ${result.error?.message ?? result.stderr.trim().split("\n").slice(-3).join(" ")}`
        );
    }

    return { ssim: Number(ssimMatch[1]), vmaf: vmafMatch ? Number(vmafMatch[1]) : null };
}

/**
 * Stacks the reference and up to three encodes of one window into a 2x2 grid video, each cell at the same size, so a
 * player shows them side by side in sync. Cells go left to right, top to bottom, in the order given.
 */
export async function buildCompareGrid({
    reference,
    encodes,
    output,
    cellHeight,
    signal,
}: {
    reference: string;
    encodes: string[];
    output: string;
    cellHeight: number;
    signal?: AbortSignal;
}): Promise<void> {
    const inputs = [reference, ...encodes.slice(0, 3)];
    const cells = inputs.map(
        (_, index) => `[${index}:v]setpts=PTS-STARTPTS,scale=-2:${cellHeight}:flags=lanczos[c${index}]`
    );
    const labels = inputs.map((_, index) => `[c${index}]`).join("");
    const stack =
        inputs.length <= 2
            ? `${labels}hstack=inputs=${inputs.length}:shortest=1`
            : `${labels}xstack=inputs=${inputs.length}:layout=${["0_0", "w0_0", "0_h0", "w0_h0"].slice(0, inputs.length).join("|")}:fill=black:shortest=1`;
    const result = await boundedCommand({
        command: ffmpegCommand([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-v",
            "error",
            ...inputs.flatMap((input) => ["-i", input]),
            "-filter_complex",
            `${cells.join(";")};${stack}`,
            "-c:v",
            "libx264",
            "-crf",
            "12",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-an",
            output,
        ]),
        timeoutMs: 10 * 60_000,
        signal,
    });

    if (result.error || result.status !== 0) {
        throw new Error(`ffmpeg could not build the comparison grid: ${result.error?.message ?? result.stderr.trim()}`);
    }
}
