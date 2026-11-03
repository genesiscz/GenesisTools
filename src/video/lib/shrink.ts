import { constants, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { primaryVideo, readMediaFacts } from "@genesiscz/utils/video/media-facts";
import { buildCompareGrid, measureQuality, type QualityScore } from "@genesiscz/utils/video/quality";
import {
    type AudioRequest,
    findEncoder,
    VIDEO_PRESET_NAMES,
    VIDEO_PRESETS,
    type VideoPreset,
} from "@genesiscz/utils/video/reencode";
import { type EncodeProgressEvent, type EncodeRow, encodeVideos } from "../encode";
import {
    availablePresets,
    cutReferences,
    type HeightRequest,
    type PresetPreview,
    type PresetSkip,
    planShrink,
    presetsForContainer,
    previewPresets,
    type References,
    recommendFromPreviews,
    type ShrinkPlan,
    type ShrinkStep,
    settleHeight,
} from "../shrink/preview";
import type { Recommendation } from "../shrink/recommend";

export interface FinalCheck {
    windows: ({ label: string } & QualityScore)[];
}

/** What the shrink workflow reports while it runs, in order; a door turns each into a spinner, a line or JSON. */
export type ShrinkEvent =
    | { type: "reading" }
    | { type: "plan"; plan: ShrinkPlan }
    | { type: "skip"; skip: PresetSkip }
    | { type: "sampling" }
    | ShrinkStep
    | { type: "height"; plan: ShrinkPlan }
    | { type: "sampled"; plan: ShrinkPlan; previews: PresetPreview[] }
    | {
          type: "previews";
          plan: ShrinkPlan;
          previews: PresetPreview[];
          recommendation: Recommendation | null;
          recommended: VideoPreset | undefined;
      }
    | { type: "comparing" }
    | { type: "compared"; path: string; previews: PresetPreview[] };

/** The progress sink of the final encode: the door starts it right before the encode and stops it right after. */
export interface ShrinkEncodeSink {
    onProgress?: (event: EncodeProgressEvent) => void;
    onRow?: (row: EncodeRow) => void;
    stop(): void;
}

export interface ShrinkOptions {
    input: string;
    targetBytes?: number;
    heightRequest: HeightRequest;
    audioRequest: AudioRequest;
    windowSec: number;
    /** One preset to preview and encode; every preset when absent. */
    preset?: VideoPreset;
    /** Encode the sample windows; false goes straight to the encode with `preset` (or the choice). */
    preview: boolean;
    previewOnly: boolean;
    compare: boolean;
    replace: boolean;
    signal: AbortSignal;
    onEvent?: (event: ShrinkEvent) => void;
    /** Picks the preset to encode from the previews, or null to stop; asked only when no `preset` was given. */
    choosePreset: (input: {
        previews: PresetPreview[];
        recommended: VideoPreset | undefined;
    }) => Promise<VideoPreset | null>;
    startEncode: () => ShrinkEncodeSink;
}

export interface ShrinkReport {
    plan: ShrinkPlan;
    previews: PresetPreview[];
    recommendation: Recommendation | null;
    compareGrid: string | null;
}

/**
 * How the workflow ended: `no-preset` (nothing can encode this file here), `previewed` (`previewOnly`), `not-chosen`
 * (the choice was none), `no-encoder` (the chosen preset has no encoder), or `encoded` (the row says whether the result
 * was written, and `final` holds its measured quality).
 */
export type ShrinkOutcome =
    | { kind: "no-preset"; plan: ShrinkPlan }
    | ({ kind: "previewed" } & ShrinkReport)
    | ({ kind: "not-chosen" } & ShrinkReport)
    | ({ kind: "no-encoder"; chosen: VideoPreset } & ShrinkReport)
    | ({ kind: "encoded"; chosen: VideoPreset; row: EncodeRow | null; final: FinalCheck | null } & ShrinkReport);

/** A shrink that failed for a reason other than the signal; its samples stay in `workDir` for a look. */
export class ShrinkFailedError extends Error {
    constructor(
        cause: unknown,
        readonly workDir: string
    ) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.name = "ShrinkFailedError";
    }
}

export function isWritten(row: EncodeRow): boolean {
    return row.status === "kept" || row.status === "kept-beside";
}

/**
 * Plans the shrink, previews the presets on the sample windows, recommends one, optionally writes the comparison
 * video, encodes with the chosen preset and measures the result against the same windows. The work folder is removed
 * at the end, unless the run failed (then `ShrinkFailedError` names it); a cancelled run removes it too.
 */
export async function runShrinkWorkflow(options: ShrinkOptions): Promise<ShrinkOutcome> {
    const workDir = mkdtempSync(join(tmpdir(), "genesis-shrink-"));
    let keepWorkDir = false;

    try {
        return await shrinkIn({ options, workDir });
    } catch (error) {
        if (options.signal.aborted) {
            throw error;
        }

        keepWorkDir = true;
        throw new ShrinkFailedError(error, workDir);
    } finally {
        if (!keepWorkDir) {
            rmSync(workDir, { recursive: true, force: true });
        }
    }
}

async function shrinkIn({ options, workDir }: { options: ShrinkOptions; workDir: string }): Promise<ShrinkOutcome> {
    const { input, preset, signal } = options;
    const emit = (event: ShrinkEvent) => options.onEvent?.(event);

    emit({ type: "reading" });
    const facts = await readMediaFacts({ input, signal });
    let plan = await planShrink({
        facts,
        targetBytes: options.targetBytes,
        heightRequest: options.heightRequest,
        audioRequest: options.audioRequest,
        windowSec: options.windowSec,
        signal,
    });
    emit({ type: "plan", plan });

    const wanted: VideoPreset[] = preset ? [preset] : [...VIDEO_PRESET_NAMES];
    const container = presetsForContainer({ presets: wanted, input });
    const machine = await availablePresets(container.usable);
    const usable = machine.usable;

    for (const skip of [...container.skipped, ...machine.skipped]) {
        emit({ type: "skip", skip });
    }

    if (usable.length === 0) {
        return { kind: "no-preset", plan };
    }

    let previews: PresetPreview[] = [];
    let references: References = new Map();

    if (options.preview) {
        emit({ type: "sampling" });
        references = await cutReferences({ plan, workDir, onStep: emit, signal });

        if (plan.heightAuto) {
            plan = await settleHeight({ plan, references, workDir, onStep: emit, signal });
            emit({ type: "height", plan });
        }

        previews = await previewPresets({ plan, references, presets: usable, workDir, onStep: emit, signal });
        emit({ type: "sampled", plan, previews });
    }

    const recommendation = previews.length > 1 ? recommendFromPreviews(plan, previews) : null;
    const recommended = preset ?? recommendation?.preset ?? (options.preview ? previews[0]?.preset : "compatible");
    emit({ type: "previews", plan, previews, recommendation, recommended });

    let compareGrid: string | null = null;
    const hardest = references.get("hardest") ?? [...references.values()][0];

    if (options.compare && hardest && previews.length > 0) {
        emit({ type: "comparing" });
        const label = references.has("hardest") ? "hardest" : plan.windows[0]?.label;
        const encodes = previews.flatMap((entry) =>
            entry.windows.filter((window) => window.label === label).map((window) => window.path)
        );
        const sourceHeight = primaryVideo(facts)?.height ?? 720;
        const built = join(workDir, "compare.mp4");
        await buildCompareGrid({
            reference: hardest,
            encodes,
            output: built,
            cellHeight: Math.min(sourceHeight, 720),
            signal,
        });
        compareGrid = publishCompareGrid({ built, input });
        emit({ type: "compared", path: compareGrid, previews });
    }

    const report: ShrinkReport = { plan, previews, recommendation, compareGrid };

    if (options.previewOnly) {
        return { kind: "previewed", ...report };
    }

    const chosen = preset ?? (await options.choosePreset({ previews, recommended }));

    if (!chosen) {
        return { kind: "not-chosen", ...report };
    }

    const encoder = findEncoder(VIDEO_PRESETS[chosen]);

    if (!encoder) {
        return { kind: "no-encoder", chosen, ...report };
    }

    const sink = options.startEncode();
    const rows = await encodeVideos({
        paths: [input],
        encoder,
        quality: encoder.defaultQuality,
        targetBytes: options.targetBytes,
        height: plan.height.height,
        audio: plan.audio.kind === "copy" ? "copy" : plan.audio.kbps,
        jobs: 1,
        minSavingPct: 0,
        replace: options.replace,
        dryRun: false,
        signal,
        onProgress: sink.onProgress,
        onRow: sink.onRow,
    }).finally(() => sink.stop());
    const row = rows[0] ?? null;
    const final =
        row?.output && isWritten(row) ? await verifyFinal({ plan, references, output: row.output, signal }) : null;
    return { kind: "encoded", chosen, row, final, ...report };
}

/**
 * Copies the grid built in the work folder beside the input under the first free `<name>.compare[-N].mp4`. The copy
 * refuses a taken name (COPYFILE_EXCL), so an existing file is never replaced, and it works when the temp folder is on
 * another volume, where a hard link or a rename would not.
 */
function publishCompareGrid({ built, input }: { built: string; input: string }): string {
    const stem = join(dirname(input), `${basename(input, extname(input))}.compare`);

    for (let index = 1; index < 100; index++) {
        const target = index === 1 ? `${stem}.mp4` : `${stem}-${index}.mp4`;

        try {
            copyFileSync(built, target, constants.COPYFILE_EXCL);
            return target;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }
    }

    throw new Error(`${stem}.mp4 and 98 numbered names after it are all taken`);
}

async function verifyFinal({
    plan,
    references,
    output,
    signal,
}: {
    plan: ShrinkPlan;
    references: References;
    output: string;
    signal: AbortSignal;
}): Promise<FinalCheck | null> {
    if (references.size === 0) {
        return null;
    }

    const windows: FinalCheck["windows"] = [];

    for (const window of plan.windows) {
        const reference = references.get(window.label);

        if (reference) {
            windows.push({
                label: window.label,
                ...(await measureQuality({ distorted: output, reference, distortedWindow: window, signal })),
            });
        }
    }

    return { windows };
}
