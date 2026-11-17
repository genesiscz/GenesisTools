import {
    type ComponentType,
    type CSSProperties,
    createContext,
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode,
    useContext,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import {
    type CompareRect,
    type CompareSize,
    type CompareView,
    canPan,
    NO_SHIFT,
    paneHeight,
    panKeyDelta,
    panView,
    resolveView,
    type Shift,
    shiftText,
    type ViewTransform,
    zoomViewAt,
} from "./core";
import type { IdleCache, PixelPair } from "./load";

/**
 * The stage every mode draws into: a pane that owns zoom and pan (Ctrl or Cmd plus the wheel zooms at the pointer, a
 * drag or the arrow keys pan once the canvas is larger than the pane), layers that carry the shared transform, and
 * the small parts the modes share. A mode is a `CompareMode` object; `registry.ts` lists them.
 */

// ─── The mode interface ───

/** One image of the comparison, with its natural size. */
export interface CompareImage {
    src: string;
    label: string;
    alt: string;
    width: number;
    height: number;
}

/**
 * Decoded pixels of both images and the shift estimate, for a mode with `needsPixels`; off for the other modes. A
 * pixel mode computes its own product (a diff, a heat map) from the pair, so a new one needs no shared type.
 */
export type PixelState =
    | { status: "off" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; pair: PixelPair };

export type CompareSettingValue = string | number | boolean;

/** Per-comparison settings of every mode, keyed `<mode id>.<name>`, so a new mode needs no shared type. */
export type CompareSettings = Readonly<Record<string, CompareSettingValue | undefined>>;

/**
 * Starting values of mode controls that the page sets through ImageCompare's props, nested by mode. A control on the
 * comparison overrides its value in `settings`.
 */
export interface CompareModeDefaults {
    blink: {
        /** Auto flip interval in ms. */
        interval: number;
    };
    diff: {
        /** Opacity of the grey underlay under the pink pixels, 0 to 1. */
        underlayOpacity: number;
    };
}

export const COMPARE_MODE_DEFAULTS: CompareModeDefaults = {
    blink: { interval: 700 },
    diff: { underlayOpacity: 0.4 },
};

/** A pane's inner size and the canvas it draws. */
export interface PaneGeometry {
    pane: CompareSize;
    canvas: CompareSize;
}

export interface CompareStageProps {
    /** Image A (before) and image B (after). */
    a: CompareImage;
    b: CompareImage;
    /** The common canvas: the larger width and height. Both images sit at its top-left corner. */
    canvas: CompareSize;
    view: CompareView;
    setView: (update: (view: CompareView) => CompareView) => void;
    /** Shows `rect` of the canvas whole in every pane. */
    zoomTo: (rect: CompareRect) => void;
    /**
     * A pane reports its size and the canvas it draws (an aligned pair's in Diff and Heat), so the zoom buttons, the
     * zoom label and a region's zoom work on what is on screen.
     */
    onPaneGeometry: (geometry: PaneGeometry) => void;
    maxHeight: number;
    pixels: PixelState;
    /** pixelmatch threshold of this comparison and its setter (the comparison then keeps its own). */
    threshold: number;
    setThreshold: (threshold: number) => void;
    settings: CompareSettings;
    setSetting: (key: string, value: CompareSettingValue) => void;
    /** The page's starting values for mode controls (ImageCompare's props). */
    defaults: CompareModeDefaults;
}

export interface CompareMode {
    /** "side-by-side" | "slider" | "blink" | "fade" | "diff" | "heat" */
    id: string;
    /** Sentence case, shown on the switch. */
    label: string;
    /** Draws the mode into the stage. */
    Stage: ComponentType<CompareStageProps>;
    /** Optional controls row under the switch (threshold, opacity, underlay). */
    Controls?: ComponentType<CompareStageProps>;
    /** True when the mode needs decoded pixels of both images (diff, heat). */
    needsPixels?: boolean;
    /** Keys of this mode's settings that a comparison with an `id` saves, so a reload keeps them (Blink's interval). */
    saved?: readonly string[];
}

export function numberSetting(settings: CompareSettings, key: string, fallback: number): number {
    const value = settings[key];

    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function boolSetting(settings: CompareSettings, key: string, fallback: boolean): boolean {
    const value = settings[key];

    return typeof value === "boolean" ? value : fallback;
}

export function choiceSetting<T extends string>(
    settings: CompareSettings,
    key: string,
    choices: readonly T[],
    fallback: T
): T {
    const value = settings[key];

    return choices.find((choice) => choice === value) ?? fallback;
}

// ─── Pane and layers ───

const TransformContext = createContext<{ transform: ViewTransform; canvas: CompareSize; pane: CompareSize }>({
    transform: { scale: 1, x: 0, y: 0 },
    canvas: { width: 0, height: 0 },
    pane: { width: 0, height: 0 },
});

/** The transform of the pane around the caller: for marks that must keep their screen size at any zoom. */
export function useViewTransform(): ViewTransform {
    return useContext(TransformContext).transform;
}

/** The inner size of the pane around the caller (its `side` included): for marks placed in screen pixels. */
export function usePaneSize(): CompareSize {
    return useContext(TransformContext).pane;
}

/** The canvas the pane around the caller draws: for marks placed against the image's edges. */
export function useCanvasSize(): CompareSize {
    return useContext(TransformContext).canvas;
}

/** A pane click that did not move the pointer further than this is a tap, not a pan. */
const TAP_DISTANCE = 4;

export interface ComparePaneProps {
    stage: CompareStageProps;
    /** Names the pane for assistive technology. */
    label: string;
    children: ReactNode;
    /** A click or tap that did not pan (Blink flips on it). */
    onTap?: () => void;
    /**
     * Keys for the mode while the pane has focus (Blink's Space); the comparison's own keys bubble past it. The arrow
     * keys pan a zoomed pane unless this handler (or a control inside the pane, such as Slider's handle) took them.
     */
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
    /** The canvas this pane shows, when a mode draws a different one (an aligned pair). Default: the stage's. */
    canvas?: CompareSize;
    /**
     * What the pane shows, in a strip above it: a label never sits on the image, where it would hide the very
     * pixels being compared. `captionEnd` goes to the right end of the strip (Slider's B).
     */
    caption?: ReactNode;
    captionEnd?: ReactNode;
    /**
     * A strip at the right of the pane, as tall as the pane (Diff's region numbers). It shares the pane's transform,
     * so what it draws can point into the pane; `sideWidth` is its width in px.
     */
    side?: ReactNode;
    sideWidth?: number;
}

/**
 * One pannable, zoomable pane. Its height follows the canvas aspect, capped at the comparison's maxHeight. It takes
 * focus on a click, so the comparison's keys work right after the user points at an image.
 */
export function ComparePane({
    stage: stageProps,
    label,
    children,
    onTap,
    onKeyDown,
    canvas,
    caption,
    captionEnd,
    side,
    sideWidth = 0,
}: ComparePaneProps) {
    const stage = canvas ? { ...stageProps, canvas } : stageProps;
    const paneRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    const [dragging, setDragging] = useState(false);
    const drag = useRef<{ id: number; x: number; y: number; moved: boolean; pans: boolean } | null>(null);
    const latest = useRef(stage);
    latest.current = stage;
    const height = paneHeight({ canvas: stage.canvas, width, maxHeight: stage.maxHeight });
    const pane = { width, height };
    const transform = resolveView(stage.view, pane, stage.canvas);
    const pannable = width > 0 && canPan(stage.view, pane, stage.canvas);
    const { onPaneGeometry } = stage;
    const { width: canvasWidth, height: canvasHeight } = stage.canvas;

    useLayoutEffect(() => {
        const element = paneRef.current;

        if (!element) {
            return;
        }

        // The layers draw inside the border, so the inner width is the pane's width (and box-content makes the
        // style height the inner height too).
        const measure = (): void => setWidth(element.clientWidth);
        measure();

        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", measure);

            return () => window.removeEventListener("resize", measure);
        }

        const observer = new ResizeObserver(measure);
        observer.observe(element);

        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (width > 0) {
            onPaneGeometry({ pane: { width, height }, canvas: { width: canvasWidth, height: canvasHeight } });
        }
    }, [width, height, canvasWidth, canvasHeight, onPaneGeometry]);

    // React's wheel listener is passive, so it cannot keep the page from scrolling; this one can.
    useEffect(() => {
        const element = paneRef.current;

        if (!element) {
            return;
        }

        const onWheel = (event: WheelEvent): void => {
            if (!event.ctrlKey && !event.metaKey) {
                return;
            }

            event.preventDefault();
            const rect = element.getBoundingClientRect();
            const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
            const factor = Math.exp(-event.deltaY * lines * 0.002);
            const now = latest.current;
            now.setView((view) =>
                zoomViewAt({
                    view,
                    pane: { width: element.clientWidth, height: element.clientHeight },
                    canvas: now.canvas,
                    factor,
                    point: {
                        x: event.clientX - rect.left - element.clientLeft,
                        y: event.clientY - rect.top - element.clientTop,
                    },
                })
            );
        };
        element.addEventListener("wheel", onWheel, { passive: false });

        return () => element.removeEventListener("wheel", onWheel);
    }, []);

    const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0) {
            return;
        }

        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, pans: pannable };

        if (pannable) {
            event.currentTarget.setPointerCapture(event.pointerId);
        }
    };

    const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
        const current = drag.current;

        if (!current || current.id !== event.pointerId) {
            return;
        }

        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;

        if (!current.moved && Math.hypot(dx, dy) < TAP_DISTANCE) {
            return;
        }

        current.moved = true;

        if (!current.pans) {
            return;
        }

        setDragging(true);
        current.x = event.clientX;
        current.y = event.clientY;
        stage.setView((view) => panView({ view, pane, canvas: stage.canvas, dx, dy }));
    };

    const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
        const current = drag.current;

        if (!current || current.id !== event.pointerId) {
            return;
        }

        drag.current = null;
        setDragging(false);

        if (!current.moved && event.type === "pointerup") {
            onTap?.();
        }
    };

    // The keyboard's way to pan, where a drag pans. An arrow the mode or a control inside the pane took stays theirs.
    const onKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
        onKeyDown?.(event);

        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !pannable) {
            return;
        }

        const delta = panKeyDelta({ key: event.key, shift: event.shiftKey, pane });

        if (!delta) {
            return;
        }

        event.preventDefault();
        stage.setView((view) => panView({ view, pane, canvas: stage.canvas, ...delta }));
    };

    const cursor = dragging ? "cursor-grabbing" : pannable ? "cursor-grab" : onTap ? "cursor-pointer" : "";
    const style: CSSProperties = { height: width > 0 ? height : undefined, touchAction: pannable ? "none" : "auto" };

    return (
        <div className="min-w-0">
            {caption !== undefined || captionEnd !== undefined ? (
                <div
                    data-stage-caption=""
                    className="mb-1 flex min-h-4 items-end justify-between gap-3 text-xs font-medium leading-4 text-dim"
                >
                    <span className="min-w-0 truncate">{caption}</span>
                    {captionEnd !== undefined ? (
                        <span className="min-w-0 truncate text-right">{captionEnd}</span>
                    ) : null}
                </div>
            ) : null}
            <TransformContext.Provider value={{ transform, canvas: stage.canvas, pane }}>
                <div className="flex">
                    <div
                        ref={paneRef}
                        role="group"
                        aria-label={label}
                        tabIndex={0}
                        onKeyDown={onKeys}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                        className={`relative box-content min-h-24 min-w-0 flex-1 select-none overflow-hidden rounded-card border border-line bg-canvas ${cursor} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-info`}
                        style={style}
                    >
                        {children}
                    </div>
                    {side !== undefined ? (
                        <div
                            className="relative shrink-0"
                            style={{ width: sideWidth, height: width > 0 ? height : undefined }}
                        >
                            {side}
                        </div>
                    ) : null}
                </div>
            </TransformContext.Provider>
        </div>
    );
}

/** A full-pane layer that draws the canvas with the pane's transform. `clip` is a CSS clip-path in pane space. */
export function ViewLayer({ children, clip, style }: { children: ReactNode; clip?: string; style?: CSSProperties }) {
    const { transform, canvas } = useContext(TransformContext);

    return (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ clipPath: clip, ...style }}>
            <div
                className="absolute left-0 top-0 origin-top-left"
                style={{
                    width: canvas.width,
                    height: canvas.height,
                    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

/** An image at its natural size, at the canvas's top-left or at `at`; past 100% its pixels stay sharp. */
export function StageImage({
    image,
    className = "",
    at,
    opacity,
}: {
    image: CompareImage;
    className?: string;
    at?: { x: number; y: number };
    opacity?: number;
}) {
    const { scale } = useViewTransform();

    return (
        <img
            src={image.src}
            alt={image.alt}
            width={image.width}
            height={image.height}
            draggable={false}
            className={`absolute block max-w-none ${className}`}
            style={{
                left: at?.x ?? 0,
                top: at?.y ?? 0,
                width: image.width,
                height: image.height,
                imageRendering: scale > 1 ? "pixelated" : undefined,
                opacity,
            }}
        />
    );
}

/** A labelled range input for a mode's controls row. */
export function RangeControl({
    label,
    min,
    max,
    step,
    value,
    onChange,
    format = String,
}: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    onChange: (value: number) => void;
    format?: (value: number) => string;
}) {
    return (
        <label className="flex min-w-48 items-center gap-2 text-xs text-dim">
            <span>{label}</span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                className="min-w-24 flex-1 accent-(--accent)"
            />
            <span className="w-10 font-mono text-ink">{format(value)}</span>
        </label>
    );
}

/** A labelled checkbox for a mode's controls row. */
export function ToggleControl({
    label,
    checked,
    onChange,
    disabled,
    hint,
}: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    /** Why the toggle is disabled, shown after it. */
    hint?: string;
}) {
    return (
        <label
            className={`flex items-center gap-2 text-sm text-ink/90 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
        >
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked)}
                className="accent-(--accent)"
            />
            {label}
            {hint ? <span className="text-xs text-dim">{hint}</span> : null}
        </label>
    );
}

// ─── Pixel modes ───

/** The pixel modes' shared setting: apply the found shift (on by default when one is found). */
const ALIGN = "align";
/** Waits for a dragged control to settle before a computation starts. */
const SETTLE_MS = 120;

/** The shift a pixel mode applies: the estimate, unless the user turned Align off. */
export function appliedShift(props: CompareStageProps): Shift {
    const { pixels } = props;

    if (pixels.status !== "ready" || !pixels.pair.shift || !boolSetting(props.settings, ALIGN, true)) {
        return NO_SHIFT;
    }

    return pixels.pair.shift;
}

/** True when a pixel mode compares a shifted pair; its summary then says so. */
export function isAligned(shift: Shift): boolean {
    return shift.dx !== 0 || shift.dy !== 0;
}

/** "After is shifted by +3, +12 px" and the Align toggle, when the estimate found a shift. */
export function AlignControl(props: CompareStageProps) {
    const shift = props.pixels.status === "ready" ? props.pixels.pair.shift : null;

    if (!shift || !isAligned(shift)) {
        return null;
    }

    return (
        <span className="flex items-center gap-3">
            <span className="text-xs text-ink">{shiftText(shift, props.b.label)}</span>
            <ToggleControl
                label="Align"
                checked={boolSetting(props.settings, ALIGN, true)}
                onChange={(checked) => props.setSetting(ALIGN, checked)}
            />
        </span>
    );
}

export type IdleResult<T> = { status: "loading" } | { status: "ready"; value: T; ms: number; stale: boolean };

/**
 * A pixel mode's product, computed after the browser goes idle and cached by the job's key. While a new key computes,
 * the last result of the same `group` (the same pair of images) stays on screen, marked stale.
 */
export function useIdleCompute<T>({
    cache,
    group,
    job,
}: {
    cache: IdleCache<T>;
    group: string;
    /** Null until the inputs are ready. */
    job: { key: string; compute: () => T } | null;
}): IdleResult<T> {
    const [last, setLast] = useState<{ key: string; group: string; value: T; ms: number }>();
    const latest = useRef(job);
    latest.current = job;
    const key = job?.key ?? null;

    useEffect(() => {
        const current = latest.current;

        if (key === null || !current) {
            return;
        }

        const hit = cache.peek(key);

        if (hit) {
            setLast({ key, group, value: hit.value, ms: hit.ms });
            return;
        }

        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            cache.run({ key, compute: current.compute, signal: controller.signal }).then((result) => {
                if (result && !controller.signal.aborted) {
                    setLast({ key, group, value: result.value, ms: result.ms });
                }
            });
        }, SETTLE_MS);

        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [cache, key, group]);

    const hit = key === null ? undefined : cache.peek(key);

    if (hit) {
        return { status: "ready", value: hit.value, ms: hit.ms, stale: false };
    }

    if (last && last.group === group) {
        return { status: "ready", value: last.value, ms: last.ms, stale: true };
    }

    return { status: "loading" };
}

/** After a stale summary: the numbers belong to the product on screen, not yet to the settings now chosen. */
export function StaleNote() {
    return <span className="text-warn">. Updating for the new settings...</span>;
}

/** The loading line or the error of a pixel mode, over its pane. */
export function PixelNotice({ pixels, computing }: { pixels: PixelState; computing: boolean }) {
    if (pixels.status === "error") {
        return (
            <div role="alert" className="absolute inset-0 z-[3] flex items-center justify-center p-4 text-center">
                <span className="rounded-card border border-warn bg-panel px-3 py-2 text-sm text-warn">
                    {pixels.message}
                </span>
            </div>
        );
    }

    if (pixels.status === "loading" || computing) {
        return (
            <div className="absolute inset-0 z-[3] flex items-center justify-center text-sm text-dim">
                Reading the pixels...
            </div>
        );
    }

    return null;
}
