import { useEffect, useRef } from "react";
import { readableTextOn } from "../../color";
import { Button } from "../../forms";
import { SegmentedControl } from "../../primitives";
import {
    type CompareRegion,
    DIFF_THRESHOLD_MAX,
    DIFF_THRESHOLD_MIN,
    diffSummary,
    IMAGE_DIFF_COLOR,
    type ImageDiff,
    REGION_OUTLINE_REACH,
    regionLabelSide,
} from "../core";
import {
    boolSetting,
    type CompareMode,
    ComparePane,
    type CompareStageProps,
    choiceSetting,
    numberSetting,
    RangeControl,
    StageImage,
    StageLabel,
    ToggleControl,
    useViewTransform,
    ViewLayer,
} from "../stage";

const UNDERLAY = "diff.underlay";
const REGIONS = "diff.regions";
const REGION = "diff.region";
const UNDERLAYS = ["after", "before", "mask"] as const;
const REGION_INK = readableTextOn(IMAGE_DIFF_COLOR);

/** The overlay as a canvas the size of the common canvas: pink where a pixel differs. */
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

/** pixelmatch's changed pixels in pink over the chosen underlay, with boxes around the changed regions. */
function DiffStage(props: CompareStageProps) {
    const underlay = choiceSetting(props.settings, UNDERLAY, UNDERLAYS, "after");
    const showRegions = boolSetting(props.settings, REGIONS, true);
    const active = numberSetting(props.settings, REGION, -1);
    const { pixels } = props;
    const shown = underlay === "after" ? props.b : underlay === "before" ? props.a : undefined;

    return (
        <ComparePane stage={props} label={`Pixel diff of ${props.a.label} and ${props.b.label}`}>
            <ViewLayer>
                {shown ? <StageImage image={shown} className="opacity-40 grayscale" /> : null}
                {pixels.status === "ready" ? <DiffCanvas diff={pixels.diff} /> : null}
                {pixels.status === "ready" && showRegions ? (
                    <RegionBoxes regions={pixels.diff.regions} active={active} />
                ) : null}
            </ViewLayer>
            <StageLabel>{shown ? `Diff over ${shown.label}` : "Diff mask"}</StageLabel>
            {pixels.status === "loading" ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-dim">
                    Computing the diff...
                </div>
            ) : null}
            {pixels.status === "error" ? (
                <div role="alert" className="absolute inset-0 flex items-center justify-center p-4 text-center">
                    <span className="rounded-card border border-warn bg-panel px-3 py-2 text-sm text-warn">
                        {pixels.message}
                    </span>
                </div>
            ) : null}
        </ComparePane>
    );
}

function DiffControls(props: CompareStageProps) {
    const underlay = choiceSetting(props.settings, UNDERLAY, UNDERLAYS, "after");
    const showRegions = boolSetting(props.settings, REGIONS, true);
    const { pixels } = props;
    const regions = pixels.status === "ready" ? pixels.diff.regions : [];
    const active = numberSetting(props.settings, REGION, -1);
    const step = (by: number): void => {
        if (regions.length === 0) {
            return;
        }

        const next = active < 0 ? (by > 0 ? 0 : regions.length - 1) : (active + by + regions.length) % regions.length;
        props.setSetting(REGION, next);
        props.zoomTo(regions[next]);
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
            <span aria-live="polite" className="text-xs text-dim">
                {pixels.status === "ready" ? (
                    <>
                        <span className="font-medium text-ink">{diffSummary(pixels.diff)}</span>
                        {` in ${Math.round(pixels.ms)} ms`}
                    </>
                ) : pixels.status === "loading" ? (
                    "Computing the diff..."
                ) : null}
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
