import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, Select } from "../forms";
import { MdInline } from "../md";
import { SegmentedControl } from "../primitives";
import {
    IMAGE_COMPARE_STORAGE_KEY,
    parseStoredThreshold,
    useImageCompare,
    useStoredValue,
    writeStored,
} from "./context";
import {
    actualSizeView,
    type CompareRect,
    type CompareSize,
    type CompareView,
    commonSize,
    compareKey,
    DEFAULT_DIFF_THRESHOLD,
    DIFF_THRESHOLD_MAX,
    DIFF_THRESHOLD_MIN,
    FIT_VIEW,
    fitScale,
    type ImageCompareItem,
    type ImageCompareSide,
    resolveCompareImages,
    sizesDifferText,
    viewForRect,
    ZOOM_STEP,
    zoomViewBy,
} from "./core";
import { loadImageSize, loadPixelPair } from "./load";
import { COMPARE_MODES, checkModeId, compareModesFor, DEFAULT_COMPARE_MODE, findCompareMode } from "./registry";
import type {
    CompareImage,
    CompareMode,
    CompareSettings,
    CompareSettingValue,
    CompareStageProps,
    PixelState,
} from "./stage";
import { RangeControl } from "./stage";

export interface ImageCompareProps {
    /** Image A. Sugar for `images[0]`. */
    before?: ImageCompareSide;
    /** Image B. Sugar for `images[1]`. */
    after?: ImageCompareSide;
    /** Two or more images. With three or more, two selects (and the keys [ and ]) pick A and B. Pass this or `before` and `after`, not both. */
    images?: ImageCompareItem[];
    /** Inline markdown under the comparison. */
    caption?: string;
    /** Mode ids the switch offers, in registry order. Default: every registered mode. */
    modes?: string[];
    /** This comparison's mode until the user picks one on the page switch or on the comparison. Default: the page mode, else "side-by-side". */
    defaultMode?: string;
    /** pixelmatch colour threshold, 0 to 1 (default 0.15). The user's pick on the page or the comparison wins over it. */
    threshold?: number;
    /** Saves this comparison's own mode and threshold under this id, so a reload keeps them. */
    id?: string;
    /** Pane height cap in px (default 640). */
    maxHeight?: number;
}

const PIXELS_OFF: PixelState = { status: "off" };
const PIXELS_LOADING: PixelState = { status: "loading" };

/**
 * The natural size of every image, loaded together, so stepping B to another image keeps the stage (and its focus)
 * instead of waiting for that image. A size is undefined while it loads and null when the image failed.
 */
function useNaturalSizes(srcs: string[]): ReadonlyMap<string, CompareSize | null> {
    const [sizes, setSizes] = useState<ReadonlyMap<string, CompareSize | null>>(() => new Map());
    const latest = useRef(srcs);
    latest.current = srcs;
    const key = srcs.join("\n");

    useEffect(() => {
        let live = true;

        for (const src of latest.current) {
            loadImageSize(src).then((size) => {
                if (live) {
                    setSizes((previous) => (previous.get(src) === size ? previous : new Map(previous).set(src, size)));
                }
            });
        }

        return () => {
            live = false;
        };
    }, [key]);

    return sizes;
}

/**
 * Both decoded images and their shift estimate, for a mode that needs pixels. Off for the other modes, so nothing is
 * decoded until a pixel mode is shown.
 */
function usePixelPair({ a, b, enabled }: { a: string; b: string; enabled: boolean }): PixelState {
    const pair = `${a}\n${b}`;
    const [state, setState] = useState<{ pair: string; pixels: PixelState }>();

    useEffect(() => {
        if (!enabled) {
            return;
        }

        let live = true;
        loadPixelPair(a, b).then((result) => {
            if (live) {
                setState({
                    pair,
                    pixels: result.ok
                        ? { status: "ready", pair: result.pair }
                        : { status: "error", message: result.error.message },
                });
            }
        });

        return () => {
            live = false;
        };
    }, [enabled, a, b, pair]);

    if (!enabled) {
        return PIXELS_OFF;
    }

    return state?.pair === pair ? state.pixels : PIXELS_LOADING;
}

/** True when a key belongs to a control that types or picks (a text input, a select), never to the comparison. */
function isTypingTarget(target: EventTarget): boolean {
    return target instanceof Element && target.closest("input, select, textarea, [contenteditable='true']") !== null;
}

/** The first candidate the comparison offers; the chain runs from the most specific choice to the kit default. */
function pickMode(allowed: CompareMode[], candidates: Array<string | undefined>): CompareMode {
    for (const id of candidates) {
        const mode = allowed.find((candidate) => candidate.id === id);

        if (mode) {
            return mode;
        }
    }

    return allowed[0];
}

function clampThreshold(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/**
 * Before and after images with a mode switch: side by side, a slider, blink, fade, a pixel diff (pink pixels, boxes
 * and a list of changed regions, a PNG download) and a colour-distance heat map, on one zoom and pan stage. A page
 * moved by a few pixels is found and aligned before the diff. Under an ImageCompareProvider it follows the page mode
 * until the user picks a mode on it; "Follow page" returns it.
 */
export function ImageCompare({
    before,
    after,
    images,
    caption,
    modes,
    defaultMode,
    threshold,
    id,
    maxHeight = 640,
}: ImageCompareProps) {
    const all = resolveCompareImages({ before, after, images });
    const [picks, setPicks] = useState({ a: 0, b: 1 });
    const first = all[Math.min(picks.a, all.length - 1)];
    const second = all[Math.min(picks.b, all.length - 1)];
    const allowed = compareModesFor(modes);
    checkModeId(defaultMode, "defaultMode");
    const page = useImageCompare();
    const itemKey = id === undefined ? undefined : `${page?.storageKey ?? IMAGE_COMPARE_STORAGE_KEY}:item:${id}`;
    // Keyed by the id, so a new id brings that comparison's own picks in the same render.
    const [ownMode, setOwnMode] = useStoredValue(
        itemKey === undefined ? undefined : `${itemKey}:mode`,
        (stored) => stored
    );
    const [ownThreshold, setOwnThreshold] = useStoredValue(
        itemKey === undefined ? undefined : `${itemKey}:threshold`,
        parseStoredThreshold
    );
    const mode = pickMode(allowed, [ownMode, page?.pickedMode, defaultMode, page?.defaultMode, DEFAULT_COMPARE_MODE]);
    const effectiveThreshold = clampThreshold(ownThreshold ?? page?.threshold ?? threshold ?? DEFAULT_DIFF_THRESHOLD);
    const detached = ownMode !== undefined || ownThreshold !== undefined;

    const sizes = useNaturalSizes(all.map((image) => image.src));
    const sizeA = sizes.get(first.src);
    const sizeB = sizes.get(second.src);
    const [view, setView] = useState<CompareView>(FIT_VIEW);
    const [pane, setPane] = useState<CompareSize | null>(null);
    const [settings, setSettings] = useState<CompareSettings>({});
    const pixels = usePixelPair({
        a: first.src,
        b: second.src,
        enabled: mode.needsPixels === true && Boolean(sizeA && sizeB),
    });
    const canvas = sizeA && sizeB ? commonSize(sizeA, sizeB) : undefined;

    const setSetting = useCallback((key: string, value: CompareSettingValue) => {
        setSettings((previous) => ({ ...previous, [key]: value }));
    }, []);
    const onPaneSize = useCallback((size: CompareSize) => {
        setPane((previous) =>
            previous && previous.width === size.width && previous.height === size.height ? previous : size
        );
    }, []);
    const zoomTo = useCallback(
        (rect: CompareRect) => {
            if (pane && canvas) {
                setView(viewForRect({ rect, pane, canvas }));
            }
        },
        [pane, canvas]
    );

    const pickOwnMode = (next: string): void => {
        setOwnMode(next);

        if (itemKey) {
            writeStored(`${itemKey}:mode`, next);
        }
    };
    const pickOwnThreshold = (next: number): void => {
        setOwnThreshold(next);

        if (itemKey) {
            writeStored(`${itemKey}:threshold`, String(next));
        }
    };
    const followPage = (): void => {
        setOwnMode(undefined);
        setOwnThreshold(undefined);

        if (itemKey) {
            writeStored(`${itemKey}:mode`, undefined);
            writeStored(`${itemKey}:threshold`, undefined);
        }
    };

    const zoomBy = (factor: number): void => {
        if (pane && canvas) {
            setView((current) => zoomViewBy({ view: current, pane, canvas, factor }));
        }
    };
    /** Steps B through the images, past A. */
    const stepB = (by: number): void => {
        setPicks((current) => {
            let next = current.b;

            do {
                next = (next + by + all.length) % all.length;
            } while (next === current.a && all.length > 1);

            return { a: current.a, b: next };
        });
    };
    const onKeys = (event: KeyboardEvent<HTMLElement>): void => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) {
            return;
        }

        const action = compareKey(event.key);

        if (
            !action ||
            (action.kind === "mode" && !allowed[action.index]) ||
            (action.kind === "step-b" && all.length < 3)
        ) {
            return;
        }

        event.preventDefault();

        if (action.kind === "mode") {
            pickOwnMode(allowed[action.index].id);
        } else if (action.kind === "zoom") {
            zoomBy(action.factor);
        } else if (action.kind === "fit") {
            setView(FIT_VIEW);
        } else {
            stepB(action.by);
        }
    };
    const scale = view.scale ?? (pane && canvas ? fitScale(pane, canvas) : 1);
    const loadFailed = [
        { size: sizeA, image: first },
        { size: sizeB, image: second },
    ].filter((entry) => entry.size === null);

    let body: ReactNode;

    if (loadFailed.length > 0) {
        body = (
            <div role="alert" className="rounded-card border border-err bg-err/10 px-3 py-2 text-sm text-err">
                {loadFailed.map((entry) => `The image did not load: ${entry.image.label}.`).join(" ")}
            </div>
        );
    } else if (!sizeA || !sizeB || !canvas) {
        body = (
            <div className="flex min-h-24 items-center justify-center rounded-card border border-line bg-canvas text-sm text-dim">
                Loading the images...
            </div>
        );
    } else {
        const a: CompareImage = { ...first, ...sizeA };
        const b: CompareImage = { ...second, ...sizeB };
        const stageProps: CompareStageProps = {
            a,
            b,
            canvas,
            view,
            setView,
            zoomTo,
            onPaneSize,
            maxHeight,
            pixels,
            threshold: effectiveThreshold,
            setThreshold: pickOwnThreshold,
            settings,
            setSetting,
        };
        const { Stage, Controls } = mode;
        const sizeNote = sizesDifferText(a, b);

        body = (
            <>
                {Controls ? (
                    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Controls {...stageProps} />
                    </div>
                ) : null}
                {sizeNote ? <p className="mb-2 text-xs text-warn">{sizeNote}</p> : null}
                <Stage {...stageProps} />
            </>
        );
    }

    return (
        <figure
            data-image-compare={id ?? ""}
            onKeyDown={onKeys}
            className="my-4 rounded-card border border-line bg-panel/60 p-3"
        >
            {all.length > 2 ? (
                <div className="mb-2 flex flex-wrap items-end gap-3">
                    {(["a", "b"] as const).map((side) => (
                        <div key={side} className="w-56">
                            <Field label={side === "a" ? "A" : "B"}>
                                <Select
                                    options={all.map((image, index) => ({ value: String(index), label: image.label }))}
                                    value={String(side === "a" ? picks.a : picks.b)}
                                    onChange={(value) => setPicks((current) => ({ ...current, [side]: Number(value) }))}
                                />
                            </Field>
                        </div>
                    ))}
                </div>
            ) : null}
            <div className="mb-2 flex flex-wrap items-center gap-2">
                {allowed.length > 1 ? (
                    <SegmentedControl
                        ariaLabel={`Compare ${first.label} and ${second.label}`}
                        options={allowed.map((option) => ({ value: option.id, label: option.label }))}
                        value={mode.id}
                        onChange={pickOwnMode}
                    />
                ) : null}
                {page && detached ? (
                    <Button size="sm" variant="ghost" onClick={followPage}>
                        Follow page
                    </Button>
                ) : null}
                <div role="toolbar" aria-label="Zoom" className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" ariaLabel="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
                        -
                    </Button>
                    <span className="w-12 text-center font-mono text-xs text-dim" aria-live="polite">
                        {`${Math.round(scale * 100)}%`}
                    </span>
                    <Button size="sm" variant="ghost" ariaLabel="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
                        +
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setView(FIT_VIEW)}>
                        Fit
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            if (pane && canvas) {
                                setView((current) => actualSizeView(current, pane, canvas));
                            }
                        }}
                    >
                        100%
                    </Button>
                </div>
            </div>
            {body}
            {caption ? (
                <figcaption className="mt-1.5 text-center text-xs text-dim">
                    <MdInline>{caption}</MdInline>
                </figcaption>
            ) : null}
            <details className="mt-1.5 text-xs text-dim">
                <summary className="w-fit cursor-pointer select-none">Keys</summary>
                <p className="mt-1">
                    {`With the comparison focused (click an image): 1 to ${allowed.length} pick a mode, + and - zoom, 0 fits.${
                        all.length > 2 ? " [ and ] step image B." : ""
                    } In Blink, Space shows the other image. Keys never reach the comparison while a text field or a select has focus.`}
                </p>
            </details>
        </figure>
    );
}

export interface ImageCompareModeSwitchProps {
    /** Visible label of the switch (default "All comparisons"). */
    label?: string;
}

/** The page switch: sets the mode, and for a pixel mode the threshold, of every comparison under the provider. */
export function ImageCompareModeSwitch({ label = "All comparisons" }: ImageCompareModeSwitchProps) {
    const page = useImageCompare();

    if (!page) {
        throw new Error("ImageCompareModeSwitch needs an ImageCompareProvider around it and the comparisons.");
    }

    const current = findCompareMode(page.pickedMode) ?? findCompareMode(page.defaultMode) ?? COMPARE_MODES[0];

    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <SegmentedControl
                label={label}
                options={COMPARE_MODES.map((option) => ({ value: option.id, label: option.label }))}
                value={current.id}
                onChange={page.setMode}
            />
            {current.needsPixels ? (
                <RangeControl
                    label="Threshold"
                    min={DIFF_THRESHOLD_MIN}
                    max={DIFF_THRESHOLD_MAX}
                    step={0.01}
                    value={page.threshold ?? DEFAULT_DIFF_THRESHOLD}
                    onChange={page.setThreshold}
                    format={(value) => value.toFixed(2)}
                />
            ) : null}
        </div>
    );
}
