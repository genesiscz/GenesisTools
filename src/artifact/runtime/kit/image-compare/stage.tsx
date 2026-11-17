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
import { Badge } from "../primitives";
import {
    type CompareRect,
    type CompareSize,
    type CompareView,
    canPan,
    type ImageDiff,
    paneHeight,
    panView,
    resolveView,
    type ViewTransform,
    zoomViewAt,
} from "./core";

/**
 * The stage every mode draws into: a pane that owns zoom and pan (Ctrl or Cmd plus the wheel zooms at the pointer, a
 * drag pans once the canvas is larger than the pane), layers that carry the shared transform, and the small parts
 * the modes share. A mode is a `CompareMode` object; `registry.ts` lists them.
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

/** Decoded pixels for a mode with `needsPixels`: off for the other modes. */
export type PixelState =
    | { status: "off" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; diff: ImageDiff; ms: number };

export type CompareSettingValue = string | number | boolean;

/** Per-comparison settings of every mode, keyed `<mode id>.<name>`, so a new mode needs no shared type. */
export type CompareSettings = Readonly<Record<string, CompareSettingValue | undefined>>;

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
    /** A pane reports its size, so the zoom buttons know what fit and 100% mean. */
    onPaneSize: (size: CompareSize) => void;
    maxHeight: number;
    pixels: PixelState;
    /** pixelmatch threshold of this comparison and its setter (the comparison then keeps its own). */
    threshold: number;
    setThreshold: (threshold: number) => void;
    settings: CompareSettings;
    setSetting: (key: string, value: CompareSettingValue) => void;
}

export interface CompareMode {
    /** "side-by-side" | "slider" | "blink" | "fade" | "diff" */
    id: string;
    /** Sentence case, shown on the switch. */
    label: string;
    /** Draws the mode into the stage. */
    Stage: ComponentType<CompareStageProps>;
    /** Optional controls row under the switch (threshold, opacity, underlay). */
    Controls?: ComponentType<CompareStageProps>;
    /** True when the mode needs decoded pixels of both images (diff). */
    needsPixels?: boolean;
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

const TransformContext = createContext<{ transform: ViewTransform; canvas: CompareSize }>({
    transform: { scale: 1, x: 0, y: 0 },
    canvas: { width: 0, height: 0 },
});

/** The transform of the pane around the caller: for marks that must keep their screen size at any zoom. */
export function useViewTransform(): ViewTransform {
    return useContext(TransformContext).transform;
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
    /** Makes the pane focusable and hands it the keys. */
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/** One pannable, zoomable pane. Its height follows the canvas aspect, capped at the comparison's maxHeight. */
export function ComparePane({ stage, label, children, onTap, onKeyDown }: ComparePaneProps) {
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
    const { onPaneSize } = stage;

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
            onPaneSize({ width, height });
        }
    }, [width, height, onPaneSize]);

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

    const cursor = dragging ? "cursor-grabbing" : pannable ? "cursor-grab" : onTap ? "cursor-pointer" : "";
    const style: CSSProperties = { height: width > 0 ? height : undefined, touchAction: pannable ? "none" : "auto" };

    return (
        <TransformContext.Provider value={{ transform, canvas: stage.canvas }}>
            <div
                ref={paneRef}
                role="group"
                aria-label={label}
                tabIndex={onKeyDown ? 0 : undefined}
                onKeyDown={onKeyDown}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className={`relative box-content min-h-24 select-none overflow-hidden rounded-card border border-line bg-canvas ${cursor} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-info`}
                style={style}
            >
                {children}
            </div>
        </TransformContext.Provider>
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

/** An image at its natural size at the canvas's top-left; past 100% its pixels stay sharp. */
export function StageImage({ image, className = "" }: { image: CompareImage; className?: string }) {
    const { scale } = useViewTransform();

    return (
        <img
            src={image.src}
            alt={image.alt}
            width={image.width}
            height={image.height}
            draggable={false}
            className={`absolute left-0 top-0 block max-w-none ${className}`}
            style={{ width: image.width, height: image.height, imageRendering: scale > 1 ? "pixelated" : undefined }}
        />
    );
}

const CORNER = { "top-left": "left-2 top-2", "top-right": "right-2 top-2" } as const;

/** An image name in a pane corner, readable over any image. */
export function StageLabel({ children, corner = "top-left" }: { children: ReactNode; corner?: keyof typeof CORNER }) {
    return (
        <span className={`pointer-events-none absolute z-[2] -ml-1.5 shadow-sm ${CORNER[corner]}`}>
            <Badge tag>{children}</Badge>
        </span>
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
