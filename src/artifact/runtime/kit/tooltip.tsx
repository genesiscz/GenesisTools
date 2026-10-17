import {
    cloneElement,
    type FocusEvent,
    isValidElement,
    type KeyboardEvent,
    type PointerEvent,
    type ReactElement,
    type ReactNode,
    useCallback,
    useId,
    useLayoutEffect,
    useRef,
    useSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { MdInline } from "./md";
import type { BodyContent, Tone } from "./primitives";

/**
 * One shared hover card for the whole page. Every target writes into a small
 * store, and ONE host node in document.body renders whatever the current owner
 * asked for, so a chart with hundreds of bars never mounts hundreds of cards.
 * The card is dark in every theme (the `--tooltip-*` tokens in styles.css).
 */

export interface TooltipRow {
    k: string;
    v: ReactNode;
    tone?: Tone;
}

export interface TooltipContent {
    title?: string;
    subtitle?: string;
    rows?: TooltipRow[];
    /** Extra blocks under a divider (a task list, for example). */
    sections?: Array<{ title?: string; rows: TooltipRow[] }>;
    /** Footer line under a divider. */
    note?: BodyContent;
    noteTone?: Tone;
}

export type TooltipInput = TooltipContent | ReactNode | (() => TooltipContent | ReactNode);

export type TooltipPlacement = "pointer" | "top" | "bottom";

/** Handlers and the describedby link a target needs. Spread them on the element. */
export interface TooltipTargetProps {
    onPointerMove: (event: PointerEvent<Element>) => void;
    onPointerLeave: (event: PointerEvent<Element>) => void;
    onPointerDown: (event: PointerEvent<Element>) => void;
    onFocus: (event: FocusEvent<Element>) => void;
    onBlur: (event: FocusEvent<Element>) => void;
    onKeyDown: (event: KeyboardEvent<Element>) => void;
    "aria-describedby"?: string;
}

export interface TooltipOptions {
    placement?: TooltipPlacement;
    disabled?: boolean;
}

export interface TooltipProps {
    content: TooltipInput;
    /** One element that can take handlers. It gets aria-describedby while the card is visible. */
    children: ReactElement<Partial<TooltipTargetProps>>;
    /** "pointer" follows the cursor. "top" and "bottom" anchor to the element. Default "pointer". */
    placement?: TooltipPlacement;
    disabled?: boolean;
}

/** Card offset from the pointer, and the margin it keeps inside the viewport. */
export const TOOLTIP_OFFSET = { x: 14, y: 12, margin: 8 } as const;

export interface TooltipPlaceInput {
    /** Pointer position, or the anchor point under or over an element. */
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
    /** "pointer" offsets from the point; "below" and "above" sit flush under or over it. */
    mode: "pointer" | "below" | "above";
}

/** Where the card goes: right of and under the pointer, kept inside the viewport, flipped above near the bottom. */
export function placeTooltip(input: TooltipPlaceInput): { left: number; top: number } {
    const { x, y, width, height, viewportWidth, viewportHeight, mode } = input;
    const { margin } = TOOLTIP_OFFSET;
    const dx = mode === "pointer" ? TOOLTIP_OFFSET.x : 0;
    const dy = mode === "pointer" ? TOOLTIP_OFFSET.y : 6;
    let left = x + dx;
    let top = mode === "above" ? y - dy - height : y + dy;

    if (left + width > viewportWidth - margin) {
        left = viewportWidth - margin - width;
    }

    if (mode !== "above" && top + height > viewportHeight - margin) {
        top = y - dy - height;
    }

    return { left: Math.max(margin, left), top: Math.max(margin, top) };
}

interface TooltipState {
    owner: string | null;
    element: Element | null;
    content: ReactNode | TooltipContent;
    x: number;
    y: number;
    mode: TooltipPlaceInput["mode"];
}

const HIDDEN: TooltipState = { owner: null, element: null, content: null, x: 0, y: 0, mode: "pointer" };
const listeners = new Set<() => void>();
let state: TooltipState = HIDDEN;
let host: HTMLElement | null = null;
let hostRoot: Root | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function cancelHide(): void {
    if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
}

function emit(next: TooltipState): void {
    cancelHide();
    state = next;

    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
}

/** The id the card carries, for a target's aria-describedby. */
export const TOOLTIP_ID = "akit-tooltip";

function onDocumentKey(event: globalThis.KeyboardEvent): void {
    if (event.key === "Escape" && state.owner) {
        emit(HIDDEN);
    }
}

function onDocumentPointerDown(event: globalThis.PointerEvent): void {
    const target = event.target;

    if (
        state.owner &&
        state.element &&
        !(target instanceof Node && (state.element.contains(target) || host?.contains(target)))
    ) {
        emit(HIDDEN);
    }
}

/** Create the shared host on first use. A new document (a test, a reload) gets a new host. */
function ensureHost(): void {
    if (host?.isConnected && host.ownerDocument === document) {
        return;
    }

    hostRoot?.unmount();
    host = document.createElement("div");
    host.dataset.akitTooltipHost = "";
    document.body.appendChild(host);
    document.addEventListener("keydown", onDocumentKey);
    document.addEventListener("pointerdown", onDocumentPointerDown);
    hostRoot = createRoot(host);
    hostRoot.render(<TooltipLayer />);
}

function isTooltipContent(value: unknown): value is TooltipContent {
    if (typeof value !== "object" || value === null || Array.isArray(value) || isValidElement(value)) {
        return false;
    }

    return ["title", "subtitle", "rows", "sections", "note"].some((key) => key in value);
}

/** Bright tone colours for the always-dark card; the theme tones are tuned for the page, not for it. */
const CARD_TONE: Record<Tone, string> = {
    ok: "#5ed6a4",
    warn: "#e8b45c",
    err: "#f0737e",
    info: "#6cb6f0",
    neutral: "var(--tooltip-dim)",
};

function Rows({ rows }: { rows: TooltipRow[] }) {
    return (
        <div className="flex flex-col gap-0.5">
            {rows.map((row, i) => (
                <div key={`${row.k}-${i}`} className="flex justify-between gap-4">
                    <span style={{ color: "var(--tooltip-dim)" }}>{row.k}</span>
                    <span
                        className="font-semibold tabular-nums"
                        style={row.tone ? { color: CARD_TONE[row.tone] } : undefined}
                    >
                        {row.v}
                    </span>
                </div>
            ))}
        </div>
    );
}

const DIVIDER = "mt-[7px] border-t pt-[7px]";

/** The card body for structured content. Exported so a page can show the same look inline. */
export function TooltipCard({ content }: { content: TooltipContent }) {
    return (
        <>
            {content.title ? <div className="text-[13px] font-[650]">{content.title}</div> : null}
            {content.subtitle ? (
                <div className="mt-1.5" style={{ color: "var(--tooltip-dim)" }}>
                    {content.subtitle}
                </div>
            ) : null}
            {content.rows?.length ? (
                <div className={content.title || content.subtitle ? "mt-1.5" : ""}>
                    <Rows rows={content.rows} />
                </div>
            ) : null}
            {content.sections?.map((section, i) => (
                <div
                    key={`${section.title ?? "section"}-${i}`}
                    className={DIVIDER}
                    style={{ borderColor: "var(--tooltip-border)" }}
                >
                    {section.title ? <div className="mb-1 font-semibold">{section.title}</div> : null}
                    <Rows rows={section.rows} />
                </div>
            ))}
            {content.note ? (
                <div
                    className={DIVIDER}
                    style={{
                        borderColor: "var(--tooltip-border)",
                        color: content.noteTone ? CARD_TONE[content.noteTone] : "var(--tooltip-dim)",
                    }}
                >
                    {typeof content.note === "string" ? <MdInline>{content.note}</MdInline> : content.note}
                </div>
            ) : null}
        </>
    );
}

function TooltipLayer() {
    const current = useSyncExternalStore(subscribe, () => state);
    const cardRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const card = cardRef.current;

        if (!card || !current.owner) {
            return;
        }

        const rect = card.getBoundingClientRect();
        const { left, top } = placeTooltip({
            x: current.x,
            y: current.y,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            mode: current.mode,
        });
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;
        card.style.visibility = "visible";
    }, [current]);

    if (!current.owner) {
        return null;
    }

    return (
        <div
            ref={cardRef}
            id={TOOLTIP_ID}
            role="tooltip"
            onPointerEnter={cancelHide}
            onPointerLeave={(event) => {
                const next = event.relatedTarget;

                if (!(next instanceof Node && current.element?.contains(next))) {
                    hideFor(current.owner ?? "");
                }
            }}
            className="fixed z-50 max-w-[400px] rounded-card border px-3 py-2.5 text-[12.5px] leading-snug shadow-[0_6px_24px_rgba(0,0,0,.35)]"
            style={{
                left: current.x,
                top: current.y,
                visibility: "hidden",
                background: "var(--tooltip-bg)",
                color: "var(--tooltip-text)",
                borderColor: "var(--tooltip-border)",
            }}
        >
            {isTooltipContent(current.content) ? <TooltipCard content={current.content} /> : current.content}
        </div>
    );
}

function resolveContent(input: TooltipInput): ReactNode | TooltipContent {
    return typeof input === "function" ? input() : input;
}

/** Hide the shared card if `owner` still holds it. */
function hideFor(owner: string): void {
    if (state.owner === owner) {
        emit(HIDDEN);
    }
}

/**
 * Tooltip handlers for one target, without a wrapper component. Spread the
 * result on the element. For hundreds of targets (bars, cells) this is the
 * cheap path: the card itself is shared.
 */
export function useTooltip(content: TooltipInput, options: TooltipOptions = {}): TooltipTargetProps {
    const owner = useId();
    const { placement = "pointer", disabled = false } = options;
    const contentRef = useRef(content);
    contentRef.current = content;
    // The input the card currently shows, so a pointer move keeps it and a NEW input (a drag preview) replaces it.
    const shownRef = useRef<TooltipInput | undefined>(undefined);
    const active = useSyncExternalStore(subscribe, () => state.owner === owner);

    useLayoutEffect(() => {
        if (disabled) {
            hideFor(owner);
        }

        return () => hideFor(owner);
    }, [owner, disabled]);

    useLayoutEffect(() => {
        if (active && !disabled && shownRef.current !== content) {
            shownRef.current = content;
            emit({ ...state, content: resolveContent(content) });
        }
    }, [active, content, disabled]);

    const showAt = useCallback(
        (element: Element, x: number, y: number, mode: TooltipPlaceInput["mode"]): void => {
            ensureHost();
            const keep = state.owner === owner && shownRef.current === contentRef.current;
            shownRef.current = contentRef.current;
            emit({ owner, element, content: keep ? state.content : resolveContent(contentRef.current), x, y, mode });
        },
        [owner]
    );

    const showAnchored = useCallback(
        (element: Element, mode: "below" | "above"): void => {
            const rect = element.getBoundingClientRect();
            showAt(element, rect.left, mode === "above" ? rect.top : rect.bottom, mode);
        },
        [showAt]
    );

    if (disabled) {
        return {
            onPointerMove: () => undefined,
            onPointerLeave: () => undefined,
            onPointerDown: () => undefined,
            onFocus: () => undefined,
            onBlur: () => undefined,
            onKeyDown: () => undefined,
        };
    }

    return {
        onPointerMove: (event) => {
            if (event.pointerType === "touch") {
                return;
            }

            if (placement === "pointer") {
                showAt(event.currentTarget, event.clientX, event.clientY, "pointer");
            } else if (state.owner !== owner) {
                showAnchored(event.currentTarget, placement === "top" ? "above" : "below");
            }
        },
        onPointerLeave: (event) => {
            if (event.pointerType !== "touch") {
                const next = event.relatedTarget;

                if (next instanceof Node && host?.contains(next)) {
                    cancelHide();
                } else {
                    cancelHide();
                    hideTimer = setTimeout(() => hideFor(owner), 150);
                }
            }
        },
        onPointerDown: (event) => {
            if (event.pointerType === "touch" && state.owner !== owner) {
                showAt(event.currentTarget, event.clientX, event.clientY, "pointer");
            }
        },
        onFocus: (event) => {
            showAnchored(event.currentTarget, placement === "top" ? "above" : "below");
        },
        onBlur: () => hideFor(owner),
        onKeyDown: (event) => {
            if (event.key === "Escape") {
                hideFor(owner);
            }
        },
        "aria-describedby": active ? TOOLTIP_ID : undefined,
    };
}

/** Hover and focus card for one element: title, subtitle, key and value rows, sections and a note. */
export function Tooltip({ content, children, placement = "pointer", disabled = false }: TooltipProps) {
    const target = useTooltip(content, { placement, disabled });
    const own = children.props;
    const describedBy = [
        ...new Set(
            [own["aria-describedby"], target["aria-describedby"]].flatMap(
                (ids) => ids?.split(/\s+/).filter(Boolean) ?? []
            )
        ),
    ].join(" ");
    const merged: Partial<TooltipTargetProps> = {
        "aria-describedby": describedBy || undefined,
        onPointerMove: (event) => {
            own.onPointerMove?.(event);
            target.onPointerMove(event);
        },
        onPointerLeave: (event) => {
            own.onPointerLeave?.(event);
            target.onPointerLeave(event);
        },
        onPointerDown: (event) => {
            own.onPointerDown?.(event);
            target.onPointerDown(event);
        },
        onFocus: (event) => {
            own.onFocus?.(event);
            target.onFocus(event);
        },
        onBlur: (event) => {
            own.onBlur?.(event);
            target.onBlur(event);
        },
        onKeyDown: (event) => {
            own.onKeyDown?.(event);
            target.onKeyDown(event);
        },
    };

    return cloneElement(children, merged);
}
