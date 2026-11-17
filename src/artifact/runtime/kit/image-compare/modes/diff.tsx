import { useEffect, useRef, useState } from "react";
import { readableTextOn } from "../../color";
import { DataTable, type DataTableCell } from "../../data";
import { Button } from "../../forms";
import { Collapse, SegmentedControl } from "../../primitives";
import {
    type CompareRegion,
    DIFF_THRESHOLD_MAX,
    DIFF_THRESHOLD_MIN,
    diffImages,
    diffSummary,
    IMAGE_DIFF_COLOR,
    type ImageDiff,
    REGION_OUTLINE_REACH,
    type RgbaImage,
    regionLabelSide,
    type Shift,
} from "../core";
import { createIdleCache } from "../load";
import {
    AlignControl,
    appliedShift,
    boolSetting,
    type CompareMode,
    ComparePane,
    type CompareStageProps,
    choiceSetting,
    type IdleResult,
    isAligned,
    numberSetting,
    PixelNotice,
    RangeControl,
    StageImage,
    ToggleControl,
    useIdleCompute,
    useViewTransform,
    ViewLayer,
} from "../stage";

const UNDERLAY = "diff.underlay";
const REGIONS = "diff.regions";
const REGION = "diff.region";
const UNDERLAYS = ["after", "before", "mask"] as const;
const REGION_INK = readableTextOn(IMAGE_DIFF_COLOR);
/** A diff of a large pair holds a canvas-sized overlay, so only the latest few stay. */
const diffCache = createIdleCache<ImageDiff>(6);

/** The diff at this comparison's threshold, on the aligned pair while Align is on. */
function useDiff(props: CompareStageProps): { result: IdleResult<ImageDiff>; shift: Shift } {
    const shift = appliedShift(props);
    const { pixels, threshold } = props;
    const group = `${props.a.src}\n${props.b.src}`;
    const pair = pixels.status === "ready" ? pixels.pair : null;
    const result = useIdleCompute({
        cache: diffCache,
        group,
        job: pair
            ? {
                  key: `${group}\n${threshold}\n${shift.dx},${shift.dy}`,
                  compute: () => diffImages({ a: pair.a, b: pair.b, threshold, shift }),
              }
            : null,
    });

    return { result, shift };
}

/** The overlay as a canvas the size of the diff canvas: pink where a pixel differs. */
function DiffCanvas({ diff }: { diff: ImageDiff }) {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const context = ref.current?.getContext("2d");

        if (context) {
            context.putImageData(new ImageData(diff.overlay, diff.size.width, diff.size.height), 0, 0);
        }
    }, [diff]);

    return (
        <canvas
            ref={ref}
            width={diff.size.width}
            height={diff.size.height}
            className="absolute left-0 top-0"
            style={{ width: diff.size.width, height: diff.size.height, imageRendering: "pixelated" }}
        />
    );
}

/**
 * Region outlines that keep their screen size at any zoom. The number sits outside the outline, above the box, or
 * below it when the box is too close to the top of the image, so it never covers the box's own changed pixels.
 */
function RegionBoxes({ regions, active }: { regions: CompareRegion[]; active: number }) {
    const { scale } = useViewTransform();
    const reach = REGION_OUTLINE_REACH / scale;

    return regions.map((region, index) => {
        const above = regionLabelSide(region, scale) === "above";

        return (
            <div
                key={`${region.x}-${region.y}-${region.w}-${region.h}`}
                data-region={index + 1}
                title={`Region ${index + 1}: ${region.pixels.toLocaleString("en-US")} changed pixels`}
                className="pointer-events-auto absolute"
                style={{
                    left: region.x,
                    top: region.y,
                    width: region.w,
                    height: region.h,
                    outline: `${(index === active ? 3 : 2) / scale}px solid ${IMAGE_DIFF_COLOR}`,
                    outlineOffset: 2 / scale,
                    boxShadow: `0 0 0 ${3 / scale}px color-mix(in srgb, var(--bg) 70%, transparent)`,
                }}
            >
                {/* Scale first, then lift by the label's own height, so it ends at the outline at any zoom. */}
                <span
                    className="absolute origin-top-left whitespace-nowrap rounded-sm px-1 font-mono text-[11px] font-semibold leading-4"
                    style={{
                        left: -reach,
                        top: above ? -reach : region.h + reach,
                        background: IMAGE_DIFF_COLOR,
                        color: REGION_INK,
                        transform: above ? `scale(${1 / scale}) translate(0, -100%)` : `scale(${1 / scale})`,
                    }}
                >
                    {index + 1}
                </span>
            </div>
        );
    });
}

function goToRegion(props: CompareStageProps, regions: CompareRegion[], index: number): void {
    props.setSetting(REGION, index);
    props.zoomTo(regions[index]);
}

const REGION_COLUMNS = [
    { key: "region", label: "Region" },
    { key: "x", label: "X", mono: true },
    { key: "y", label: "Y", mono: true },
    { key: "width", label: "Width", mono: true },
    { key: "height", label: "Height", mono: true },
    { key: "pixels", label: "Pixels", mono: true },
];

/** Every changed region as a row; the number zooms the stage to it. */
function RegionTable({
    props,
    regions,
    active,
}: {
    props: CompareStageProps;
    regions: CompareRegion[];
    active: number;
}) {
    const rows = regions.map(
        (region, index): Record<string, DataTableCell> => ({
            region: (
                <button
                    type="button"
                    onClick={() => goToRegion(props, regions, index)}
                    aria-label={`Zoom to region ${index + 1}`}
                    className="font-mono font-semibold text-accent underline-offset-2 hover:underline"
                >
                    {index + 1}
                </button>
            ),
            x: region.x,
            y: region.y,
            width: region.w,
            height: region.h,
            pixels: region.pixels.toLocaleString("en-US"),
        })
    );

    return (
        <div className="mt-2">
            <Collapse summary="Changed regions" meta={String(regions.length)} open>
                <div className="max-h-72 overflow-auto">
                    <DataTable
                        columns={REGION_COLUMNS}
                        rows={rows}
                        rowTone={(_row, index) => (index === active ? "info" : undefined)}
                    />
                </div>
            </Collapse>
        </div>
    );
}

/** pixelmatch's changed pixels in pink over the chosen underlay, boxes around the changed regions, and their list. */
function DiffStage(props: CompareStageProps) {
    const underlay = choiceSetting(props.settings, UNDERLAY, UNDERLAYS, "after");
    const showRegions = boolSetting(props.settings, REGIONS, true);
    const active = numberSetting(props.settings, REGION, -1);
    const { result, shift } = useDiff(props);
    const diff = result.status === "ready" ? result.value : null;
    const shown = underlay === "after" ? props.b : underlay === "before" ? props.a : undefined;

    return (
        <>
            <ComparePane
                stage={props}
                label={`Pixel diff of ${props.a.label} and ${props.b.label}`}
                canvas={diff?.size}
                caption={shown ? `Diff over ${shown.label}` : "Diff mask"}
            >
                <ViewLayer>
                    {shown ? (
                        <StageImage
                            image={shown}
                            at={shown === props.b ? { x: -shift.dx, y: -shift.dy } : undefined}
                            className="opacity-40 grayscale"
                        />
                    ) : null}
                    {diff ? <DiffCanvas diff={diff} /> : null}
                    {diff && showRegions ? <RegionBoxes regions={diff.regions} active={active} /> : null}
                </ViewLayer>
                <PixelNotice pixels={props.pixels} computing={result.status === "loading"} />
            </ComparePane>
            {diff && diff.regions.length > 0 ? (
                <RegionTable props={props} regions={diff.regions} active={active} />
            ) : null}
        </>
    );
}

/** The image as a canvas, so it can be drawn with a filter. */
function imageCanvas(image: RgbaImage): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas
        .getContext("2d")
        ?.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);

    return canvas;
}

function fileSlug(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "image"
    );
}

/** The diff as the stage draws it: white page, the faded grey underlay, the pink pixels. Resolves false on failure. */
function downloadDiff({
    diff,
    underlay,
    at,
    name,
}: {
    diff: ImageDiff;
    underlay: RgbaImage | undefined;
    at: { x: number; y: number };
    name: string;
}): Promise<boolean> {
    const canvas = document.createElement("canvas");
    canvas.width = diff.size.width;
    canvas.height = diff.size.height;
    const context = canvas.getContext("2d");

    if (!context) {
        return Promise.resolve(false);
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    if (underlay) {
        context.filter = "grayscale(1)";
        context.globalAlpha = 0.4;
        context.drawImage(imageCanvas(underlay), at.x, at.y);
        context.filter = "none";
        context.globalAlpha = 1;
    }

    context.drawImage(imageCanvas({ ...diff.size, data: diff.overlay }), 0, 0);

    return new Promise((resolve) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                resolve(false);
                return;
            }

            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = name;
            link.click();
            // The click starts the download; the URL can go once the browser has read it.
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            resolve(true);
        }, "image/png");
    });
}

function DiffControls(props: CompareStageProps) {
    const underlay = choiceSetting(props.settings, UNDERLAY, UNDERLAYS, "after");
    const showRegions = boolSetting(props.settings, REGIONS, true);
    const { result, shift } = useDiff(props);
    const diff = result.status === "ready" ? result.value : null;
    const regions = diff?.regions ?? [];
    const active = numberSetting(props.settings, REGION, -1);
    const [downloadFailed, setDownloadFailed] = useState(false);
    const step = (by: number): void => {
        if (regions.length === 0) {
            return;
        }

        goToRegion(
            props,
            regions,
            active < 0 ? (by > 0 ? 0 : regions.length - 1) : (active + by + regions.length) % regions.length
        );
    };
    const download = (): void => {
        if (!diff || props.pixels.status !== "ready") {
            return;
        }

        const { pair } = props.pixels;
        downloadDiff({
            diff,
            underlay: underlay === "after" ? pair.b : underlay === "before" ? pair.a : undefined,
            at: underlay === "after" ? { x: -shift.dx, y: -shift.dy } : { x: 0, y: 0 },
            name: `diff-${fileSlug(props.a.label)}-${fileSlug(props.b.label)}.png`,
        }).then((ok) => setDownloadFailed(!ok));
    };

    return (
        <>
            <RangeControl
                label="Threshold"
                min={DIFF_THRESHOLD_MIN}
                max={DIFF_THRESHOLD_MAX}
                step={0.01}
                value={props.threshold}
                onChange={props.setThreshold}
                format={(value) => value.toFixed(2)}
            />
            <SegmentedControl
                label="Underlay"
                options={[
                    { value: "after", label: props.b.label },
                    { value: "before", label: props.a.label },
                    { value: "mask", label: "Mask only" },
                ]}
                value={underlay}
                onChange={(value) => props.setSetting(UNDERLAY, value)}
            />
            <ToggleControl
                label="Regions"
                checked={showRegions}
                onChange={(checked) => props.setSetting(REGIONS, checked)}
            />
            <AlignControl {...props} />
            <div className="flex items-center gap-1">
                <Button size="sm" disabled={regions.length === 0} onClick={() => step(-1)}>
                    Previous region
                </Button>
                <Button size="sm" disabled={regions.length === 0} onClick={() => step(1)}>
                    Next region
                </Button>
                {regions.length > 0 ? (
                    <span className="ml-1 text-xs text-dim">
                        {active >= 0 && active < regions.length
                            ? `Region ${active + 1} of ${regions.length}`
                            : `${regions.length} ${regions.length === 1 ? "region" : "regions"}`}
                    </span>
                ) : null}
            </div>
            <Button size="sm" disabled={!diff} onClick={download}>
                Download diff PNG
            </Button>
            {downloadFailed ? (
                <span role="alert" className="text-xs text-err">
                    The browser could not make the PNG.
                </span>
            ) : null}
            <span aria-live="polite" className="text-xs text-dim">
                {diff && result.status === "ready" ? (
                    <>
                        <span className="font-medium text-ink">{diffSummary(diff)}</span>
                        {`${isAligned(shift) ? " on the aligned pair, where both overlap," : ""} in ${Math.round(result.ms)} ms`}
                    </>
                ) : props.pixels.status === "error" ? null : (
                    "Computing the diff..."
                )}
            </span>
        </>
    );
}

export const diffMode: CompareMode = {
    id: "diff",
    label: "Diff",
    Stage: DiffStage,
    Controls: DiffControls,
    needsPixels: true,
};
