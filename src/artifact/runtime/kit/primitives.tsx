import { type CSSProperties, type ReactNode, useEffect, useId, useState } from "react";
import { highlightCode } from "../../lib/highlight";
import { type PageLook, PageLookContext, PageWidthContext, usePageLook } from "./look";
import { Md, MdInline } from "./md";

export type Tone = "ok" | "warn" | "err" | "info" | "neutral";

/**
 * A `style` object that also sets CSS custom properties (`--tilt`, `--tracks`). Declare the object with this type
 * and pass it to `style` as is: it is a CSSProperties, so no cast is needed.
 */
export type CssVarStyle = CSSProperties & { [name: `--${string}`]: string | number | undefined };

export const TONE_TEXT: Record<Tone, string> = {
    ok: "text-ok",
    warn: "text-warn",
    err: "text-err",
    info: "text-info",
    neutral: "text-dim",
};

export const TONE_BORDER: Record<Tone, string> = {
    ok: "border-ok/50",
    warn: "border-warn/50",
    err: "border-err/50",
    info: "border-info/50",
    neutral: "border-line",
};

export const TONE_BG: Record<Tone, string> = {
    ok: "bg-ok/10",
    warn: "bg-warn/10",
    err: "bg-err/10",
    info: "bg-info/10",
    neutral: "bg-panel/60",
};

/** Solid marker fill (timeline dots, status lights). */
export const TONE_DOT: Record<Tone, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    err: "bg-err",
    info: "bg-info",
    neutral: "bg-dim",
};

/** Body prop shared across the kit: a markdown string or ready-made nodes. */
export type BodyContent = string | ReactNode;

export function renderBody(body: BodyContent | undefined): ReactNode {
    if (body === undefined || body === null) {
        return null;
    }

    return typeof body === "string" ? <Md>{body}</Md> : body;
}

export interface PageProps {
    children: ReactNode;
    /** Max content width utility. Default `max-w-6xl`, or 1176 px in the document look. */
    width?: string;
    /** "dense" (default): the dashboard scale. "document": display headings, 16 px prose, roomier cards; every kit component inside follows it. */
    look?: PageLook;
    /** Full-width bar above the content, usually a `TopNav`. Its row lines up with the content width. */
    nav?: ReactNode;
    /** "glow": two soft accent glows behind the page (info at the top right, warn on the left), fixed while scrolling. */
    backdrop?: "plain" | "glow";
    /** Closing line under a rule at the bottom of the page (markdown). */
    footer?: BodyContent;
    /** Sets the browser tab title (a built file is otherwise named after its source file). */
    title?: string;
}

const GLOW_BACKDROP: CSSProperties = {
    backgroundImage:
        "radial-gradient(1100px 500px at 85% -10%, color-mix(in srgb, var(--info) 12%, transparent), transparent 70%), " +
        "radial-gradient(900px 500px at -10% 20%, color-mix(in srgb, var(--warn) 8%, transparent), transparent 70%)",
    backgroundAttachment: "fixed",
};

/** Horizontal padding of the document look: the content and the TopNav row share it. */
export const DOCUMENT_GUTTER = "px-[clamp(16px,3vw,32px)]";

/** Root wrapper: the template canvas (dark by default; the auto template follows the system), sane typography. Wrap every artifact in one Page. */
export function Page({ children, width, look = "dense", nav, backdrop = "plain", footer, title }: PageProps) {
    const isDocument = look === "document";
    const contentWidth = width ?? (isDocument ? "max-w-[1176px]" : "max-w-6xl");

    useEffect(() => {
        if (title) {
            document.title = title;
        }
    }, [title]);

    return (
        <PageLookContext.Provider value={look}>
            <PageWidthContext.Provider value={contentWidth}>
                <div
                    className={`min-h-dvh bg-canvas font-sans text-ink ${isDocument ? "text-base leading-[1.6]" : ""}`}
                    style={backdrop === "glow" ? GLOW_BACKDROP : undefined}
                >
                    {nav}
                    <div className={isDocument ? `${DOCUMENT_GUTTER} pb-10` : "px-4 py-8 sm:px-6"}>
                        <main className={`${contentWidth} mx-auto`}>
                            {children}
                            {footer ? (
                                <footer
                                    className={`border-t border-line text-dim ${isDocument ? "mt-[50px] pt-[18px] text-[14.5px] [&_code]:text-ink-2" : "mt-10 pt-3 text-xs"}`}
                                >
                                    {renderBody(footer)}
                                </footer>
                            ) : null}
                        </main>
                    </div>
                </div>
            </PageWidthContext.Provider>
        </PageLookContext.Provider>
    );
}

export interface HeroProps {
    /** Small context label above the title (uppercase in the dense look, plain mono in the document look). */
    kicker?: string;
    title: string;
    /** A phrase inside `title` painted with the accent gradient (accent, teal, lime). */
    highlight?: string;
    subtitle?: BodyContent;
    chips?: ChipItem[];
    children?: ReactNode;
}

const HIGHLIGHT_GRADIENT: CSSProperties = {
    backgroundImage: "linear-gradient(90deg, var(--accent), var(--hue-teal) 45%, var(--hue-lime))",
};

/** `title` with its `highlight` phrase wrapped in a gradient span; the plain title when the phrase is absent. */
function highlightedTitle(title: string, highlight: string | undefined): ReactNode {
    const at = highlight ? title.indexOf(highlight) : -1;

    if (!highlight || at < 0) {
        return title;
    }

    return (
        <>
            {title.slice(0, at)}
            <span className="bg-clip-text text-transparent" style={HIGHLIGHT_GRADIENT}>
                {highlight}
            </span>
            {title.slice(at + highlight.length)}
        </>
    );
}

/** Page header: kicker, display title, intro, meta chips. */
export function Hero({ kicker, title, highlight, subtitle, chips, children }: HeroProps) {
    const look = usePageLook();
    const heading = highlightedTitle(title, highlight);

    if (look === "document") {
        return (
            <header className="pt-[clamp(36px,6vw,72px)] pb-[18px]">
                {kicker ? (
                    <div className="font-mono text-[15px] font-medium leading-[normal] tracking-[0.04em] text-dim">
                        {kicker}
                    </div>
                ) : null}
                <h1 className="mt-2.5 mb-3.5 font-display text-[clamp(34px,5.2vw,60px)] font-bold leading-[1.05] tracking-[-0.02em] text-ink">
                    {heading}
                </h1>
                {subtitle ? (
                    <div className="my-[1em] max-w-[82ch] text-[clamp(17px,1.6vw,19px)] text-ink-2">
                        {renderBody(subtitle)}
                    </div>
                ) : null}
                {chips?.length ? <Chips items={chips} className="mt-3" /> : null}
                {children}
            </header>
        );
    }

    return (
        <header className="mb-8">
            {kicker ? (
                <div className="mb-1 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-dim">{kicker}</div>
            ) : null}
            <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{heading}</h1>
            {subtitle ? <div className="mt-2 text-dim">{renderBody(subtitle)}</div> : null}
            {chips?.length ? <Chips items={chips} className="mt-3" /> : null}
            {children}
        </header>
    );
}

export interface ChipItem {
    k: string;
    v: string;
    tone?: Tone;
}

export interface ChipsProps {
    items: ChipItem[];
    className?: string;
}

/** Key=value meta chips row. */
export function Chips({ items, className }: ChipsProps) {
    return (
        <div className={`flex flex-wrap gap-2 ${className ?? ""}`}>
            {items.map((c) => (
                <span
                    key={`${c.k}=${c.v}`}
                    className={`inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-xs ${TONE_BORDER[c.tone ?? "neutral"]} bg-panel/60`}
                >
                    <span className="text-dim">{c.k}</span>
                    <span className={TONE_TEXT[c.tone ?? "neutral"]}>{c.v}</span>
                </span>
            ))}
        </div>
    );
}

export interface FilterChipItem {
    id: string;
    label: string;
    /** Any CSS color, drawn as a small swatch (a lane colour). */
    color?: string;
    count?: number;
    disabled?: boolean;
}

export interface FilterChipsProps {
    items: FilterChipItem[];
    /** Pressed ids. Controlled. */
    value?: string[];
    /** Pressed ids when uncontrolled. Default: all. */
    initial?: string[];
    onChange?: (value: string[]) => void;
    /** Show All and None buttons. Ignored with `single`: one pick at a time has no "all". */
    bulk?: boolean;
    /** Pick one: pressing a chip presses only it (a filter by category). The pressed chip is drawn inverted. */
    single?: boolean;
    /** Accessible name of the group. */
    label: string;
}

const SINGLE_CHIP =
    "inline-flex items-center gap-2 rounded-full border px-3.5 py-[7px] font-mono text-sm font-semibold leading-[normal] transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-info disabled:cursor-not-allowed";

const CHIP_BASE =
    "inline-flex items-center gap-2 rounded-full border bg-panel px-3 py-[5px] text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-info disabled:cursor-not-allowed";

/**
 * Row of toggle chips that filter lanes, tags or disciplines. A chip that is
 * off keeps readable `--dim` text and gets a dashed border, so its state never
 * rests on a faded colour alone. With `single` it filters by one category at a
 * time and the pressed chip is inverted. For a mode switch use SegmentedControl.
 */
export function FilterChips({
    items,
    value,
    initial,
    onChange,
    bulk = false,
    single = false,
    label,
}: FilterChipsProps) {
    const [own, setOwn] = useState<string[]>(
        () => initial ?? (single ? items.slice(0, 1).map((item) => item.id) : items.map((item) => item.id))
    );
    const pressed = value ?? own;
    const shown = items.filter((item) => pressed.includes(item.id)).length;

    const set = (next: string[]): void => {
        if (value === undefined) {
            setOwn(next);
        }

        onChange?.(next);
    };

    const toggle = (id: string): void => {
        if (single) {
            set([id]);

            return;
        }

        set(pressed.includes(id) ? pressed.filter((p) => p !== id) : [...pressed, id]);
    };

    /** All or None, leaving disabled chips as they are. */
    const setAll = (on: boolean): void => {
        set(items.filter((item) => (item.disabled ? pressed.includes(item.id) : on)).map((item) => item.id));
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
                {items.map((item) => {
                    const on = pressed.includes(item.id);

                    return (
                        <button
                            key={item.id}
                            type="button"
                            aria-pressed={on}
                            disabled={item.disabled}
                            onClick={() => toggle(item.id)}
                            className={
                                single
                                    ? `${SINGLE_CHIP} ${on ? "border-ink bg-ink text-canvas" : "border-line-2 bg-panel text-ink-2 hover:text-ink"} ${item.disabled ? "opacity-60" : "motion-safe:hover:-translate-y-px"}`
                                    : `${CHIP_BASE} ${on ? "border-dim text-ink" : "border-dashed border-line text-dim"} ${item.disabled ? "opacity-60" : "hover:border-ink/60"}`
                            }
                        >
                            {item.color ? (
                                <span
                                    aria-hidden="true"
                                    className="inline-block h-2 w-3.5 rounded-[3px]"
                                    style={{
                                        background: on ? item.color : "transparent",
                                        boxShadow: `inset 0 0 0 1.5px ${item.color}`,
                                    }}
                                />
                            ) : null}
                            {item.label}
                            {item.count !== undefined ? (
                                <span className="font-mono text-xs text-dim">{item.count}</span>
                            ) : null}
                        </button>
                    );
                })}
            </div>
            {bulk && !single ? (
                <span className="inline-flex gap-1 text-xs">
                    <button
                        type="button"
                        onClick={() => setAll(true)}
                        className="rounded px-2 py-1 text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info"
                    >
                        All
                    </button>
                    <button
                        type="button"
                        onClick={() => setAll(false)}
                        className="rounded px-2 py-1 text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info"
                    >
                        None
                    </button>
                </span>
            ) : null}
            <span aria-live="polite" className="sr-only">
                {single
                    ? `${label}: ${items.find((item) => pressed.includes(item.id))?.label ?? "none"}`
                    : `${shown} of ${items.length} shown`}
            </span>
        </div>
    );
}

export interface BadgeProps {
    tone?: Tone;
    /** Saturated rounded pill (deep tone fill, no border) — the status-chip look. */
    pill?: boolean;
    /** Lowercase mono label (a tag after a name): soft tint of `color` or the tone, no border. */
    tag?: boolean;
    /** With `tag`: an outlined tag on a dashed border (proposed, not there yet). */
    dashed?: boolean;
    /** With `tag`: any CSS colour for the text and the tint; wins over `tone`. */
    color?: string;
    children: ReactNode;
}

const TAG_BASE =
    "ml-1.5 inline-block whitespace-nowrap rounded-md px-[7px] py-1 align-[2px] font-mono text-[13px] font-semibold leading-none tracking-[0.02em]";

/** A tag's text and tint: an explicit colour, a non-neutral tone, or the neutral nested surface. */
function tagStyle(color: string | undefined, tone: Tone): CSSProperties | undefined {
    const ink = color ?? (tone === "neutral" ? undefined : TONE_VAR[tone]);

    return ink ? { color: ink, background: `color-mix(in srgb, ${ink} 14%, transparent)` } : undefined;
}

/** Deep tone fills for pill badges — saturated enough to read as a colored chip. */
const TONE_BG_PILL: Record<Tone, string> = {
    ok: "bg-ok/20",
    warn: "bg-warn/20",
    err: "bg-err/20",
    info: "bg-info/20",
    neutral: "bg-panel",
};

/** Inline status/verdict badge. */
export function Badge({ tone = "neutral", pill = false, tag = false, dashed = false, color, children }: BadgeProps) {
    if (tag) {
        if (dashed) {
            return (
                <span className={`${TAG_BASE} border-[1.5px] border-dashed border-line-2 bg-panel-2 text-ink-2`}>
                    {children}
                </span>
            );
        }

        const style = tagStyle(color, tone);

        return (
            <span className={`${TAG_BASE} ${style ? "" : "bg-panel-2 text-ink-2"}`} style={style}>
                {children}
            </span>
        );
    }

    if (pill) {
        return (
            <span
                className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[0.68rem] font-bold uppercase tracking-wide ${TONE_BG_PILL[tone]} ${TONE_TEXT[tone]}`}
            >
                {children}
            </span>
        );
    }

    return (
        <span
            className={`inline-block rounded-card border px-1.5 py-0.5 font-mono text-[0.72rem] font-semibold uppercase tracking-wide ${TONE_BORDER[tone]} ${TONE_BG[tone]} ${TONE_TEXT[tone]}`}
        >
            {children}
        </span>
    );
}

export interface LegendItem {
    /** What the mark means (inline markdown). */
    text: string;
    /** The mark itself, usually a `<Badge tag>`. */
    mark?: ReactNode;
    /** Or a colour swatch (any CSS colour). */
    swatch?: string;
    /** With `swatch`: an outlined dashed swatch (proposed, new). */
    dashed?: boolean;
}

export interface LegendProps {
    items: LegendItem[];
}

/** Key for the marks a page uses: a tag or a swatch, then what it means. One wrapping row. */
export function Legend({ items }: LegendProps) {
    return (
        <ul className="mb-[18px] flex flex-wrap gap-x-[18px] gap-y-2.5 text-[15px] text-ink-2">
            {items.map((item) => (
                <li key={item.text} className="inline-flex items-center gap-2">
                    {item.mark ??
                        (item.swatch ? (
                            <span
                                aria-hidden="true"
                                className="inline-block h-3.5 w-3.5 rounded"
                                style={
                                    item.dashed ? { border: `2px dashed ${item.swatch}` } : { background: item.swatch }
                                }
                            />
                        ) : null)}
                    <MdInline>{item.text}</MdInline>
                </li>
            ))}
        </ul>
    );
}

export interface CalloutProps {
    tone?: Tone;
    title?: string;
    /** A rule note: a 3 px bar on the left and a faint tint instead of a full box. */
    bar?: boolean;
    /** Any CSS colour for the border, tint and title; wins over `tone`. */
    color?: string;
    children: BodyContent;
}

/** Highlighted box for verdicts, warnings, and summaries. */
export function Callout({ tone = "info", title, bar = false, color, children }: CalloutProps) {
    const look = usePageLook();
    const ink = color ?? TONE_VAR[tone];

    if (bar) {
        return (
            <div
                className="mt-4 rounded-r-[10px] border-l-[3px] px-4 py-3.5 text-ink-2"
                style={{ borderLeftColor: ink, background: `color-mix(in srgb, ${ink} 7%, var(--panel))` }}
            >
                {title ? <div className="mb-1 font-semibold text-ink">{title}</div> : null}
                {renderBody(children)}
            </div>
        );
    }

    const tinted: CSSProperties = {
        borderColor: `color-mix(in srgb, ${ink} 45%, var(--border))`,
        background: `color-mix(in srgb, ${ink} 7%, var(--panel))`,
    };

    if (look === "document") {
        return (
            <div className="rounded-[14px] border px-5 pt-[18px] pb-7" style={tinted}>
                {title ? (
                    <h3 className="mb-3 font-display text-[19px] font-semibold leading-[normal]" style={{ color: ink }}>
                        {title}
                    </h3>
                ) : null}
                <div className="text-ink-2">{renderBody(children)}</div>
            </div>
        );
    }

    return (
        <div
            className={`my-4 rounded-card border p-4 ${color ? "" : `${TONE_BORDER[tone]} ${TONE_BG[tone]}`}`}
            style={color ? tinted : undefined}
        >
            {title ? (
                <div
                    className={`mb-1 font-semibold ${color ? "" : TONE_TEXT[tone]}`}
                    style={color ? { color } : undefined}
                >
                    {title}
                </div>
            ) : null}
            <div className="text-ink/90">{renderBody(children)}</div>
        </div>
    );
}

export interface CollapseProps {
    summary: ReactNode;
    /** Right-aligned metadata on the summary row (counts, totals). */
    meta?: ReactNode;
    open?: boolean;
    children: ReactNode;
}

/** Collapsed-by-default drill-down row (native details/summary, kit-styled). */
export function Collapse({ summary, meta, open = false, children }: CollapseProps) {
    return (
        <details className="group border-t border-line" open={open}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded px-1 py-2 font-medium text-ink hover:bg-panel/60 [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="text-dim transition-transform group-open:rotate-90">
                        ▸
                    </span>
                    {summary}
                </span>
                {meta ? <span className="whitespace-nowrap font-mono text-xs text-dim">{meta}</span> : null}
            </summary>
            <div className="pb-4">{children}</div>
        </details>
    );
}

export interface SectionProps {
    title: string;
    /** Optional side note shown right of the title. */
    note?: string;
    /** Anchor id, so a TopNav link (`#id`) can jump here. */
    id?: string;
    /** Small mono number before the title ("01"). */
    number?: string;
    /** Lead paragraph under the title (markdown). */
    intro?: BodyContent;
    children: ReactNode;
}

/** Labeled content section. */
export function Section({ title, note, id, number, intro, children }: SectionProps) {
    const look = usePageLook();

    if (look === "document") {
        return (
            <section id={id} className="scroll-mt-20 pt-11 pb-2.5">
                <h2 className="mb-1.5 font-display text-[clamp(26px,3vw,34px)] font-bold leading-[1.15] tracking-[-0.01em] text-ink">
                    {number ? (
                        <span className="mr-2.5 align-middle font-mono text-[0.6em] font-semibold text-dim">
                            {number}
                        </span>
                    ) : null}
                    {title}
                </h2>
                {note ? <div className="mb-1.5 text-sm text-dim">{note}</div> : null}
                {intro ? <div className="mb-[22px] max-w-[90ch] text-ink-2">{renderBody(intro)}</div> : null}
                {children}
            </section>
        );
    }

    return (
        <section id={id} className="mt-10 scroll-mt-16 first:mt-0">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
                <h2 className="text-lg font-semibold tracking-tight text-ink">
                    {number ? <span className="mr-2 font-mono text-sm text-dim">{number}</span> : null}
                    {title}
                </h2>
                {note ? <span className="text-xs text-dim">{note}</span> : null}
            </div>
            {intro ? <div className="mb-3 text-dim">{renderBody(intro)}</div> : null}
            {children}
        </section>
    );
}

/** A KPI's change against a baseline, the second line of a stat card. */
export interface StatDelta {
    /** Signed change as text: "+8 d", "-1.5 h". */
    value: string;
    direction: "up" | "down" | "flat";
    /** Which direction is good. Colours the line: ok when it matches, err when it does not. Omit for a neutral line. */
    good?: "up" | "down";
    /** Text after the change. Default "vs baseline". */
    label?: string;
    /** The baseline value, printed in parentheses. */
    baseline?: string;
    /** Overrides the colour derived from `good`. */
    tone?: Tone;
}

export interface StatItem {
    label: string;
    value: string;
    tone?: Tone;
    /** Optional one-line detail under the label (markdown string or nodes). */
    hint?: BodyContent;
    /** Change against a baseline, drawn under the value. */
    delta?: StatDelta;
    /** 3 px left edge in this tone (marks a critical card). */
    edge?: Tone;
    /** Any CSS colour for the card's edge (the bottom edge in the document look); wins over `edge`. */
    color?: string;
}

export interface StatGridProps {
    stats: StatItem[];
    /** Minimum card width in px. When set, columns are `repeat(auto-fit, minmax(min, 1fr))`. Default: 2, 3 and 4 column steps. */
    min?: number;
}

/** Tone of a delta line: an explicit tone, else ok when the direction is the good one, err when not, neutral when flat or unrated. */
export function statDeltaTone(delta: StatDelta): Tone {
    if (delta.tone) {
        return delta.tone;
    }

    if (!delta.good || delta.direction === "flat") {
        return "neutral";
    }

    return delta.direction === delta.good ? "ok" : "err";
}

const DELTA_GLYPH: Record<StatDelta["direction"], string> = { up: "▲", down: "▼", flat: "▬" };

/** Tone as a CSS colour, for borders drawn with inline styles. */
export const TONE_VAR: Record<Tone, string> = {
    ok: "var(--ok)",
    warn: "var(--warn)",
    err: "var(--err)",
    info: "var(--info)",
    neutral: "var(--dim)",
};

/** The sentence a screen reader hears for a delta: "up 8 d versus baseline 27 Jan 2027". */
export function statDeltaSentence(delta: StatDelta): string {
    const amount = delta.value.replace(/^[+\-−]\s*/, "");
    const against = (delta.label ?? "vs baseline").replace(/^vs\.?\s+/, "versus ");

    return [delta.direction === "flat" ? "no change" : `${delta.direction} ${amount}`, against, delta.baseline]
        .filter(Boolean)
        .join(" ");
}

function StatDeltaLine({ delta }: { delta: StatDelta }) {
    return (
        <div className={`mt-0.5 text-xs leading-snug ${TONE_TEXT[statDeltaTone(delta)]}`}>
            <span aria-hidden="true">
                {DELTA_GLYPH[delta.direction]} {delta.value} {delta.label ?? "vs baseline"}
                {delta.baseline ? ` (${delta.baseline})` : ""}
            </span>
            <span className="sr-only">{statDeltaSentence(delta)}</span>
        </div>
    );
}

/** A value with every "→" drawn dim and spaced, so "6→1" reads as a transition. */
function withDimArrows(value: string): ReactNode {
    if (!value.includes("→")) {
        return value;
    }

    return value.split("→").map((part, i) => (
        <span key={`${i}-${part}`}>
            {i > 0 ? <span className="px-1.5 font-medium text-dim">→</span> : null}
            {part.trim()}
        </span>
    ));
}

/**
 * Row of headline numbers. With `min`, a delta or an edge the cards switch to
 * the compact KPI layout (label, value, delta), so seven fit one row at 1280 px.
 */
export function StatGrid({ stats, min }: StatGridProps) {
    const look = usePageLook();

    if (look === "document") {
        return (
            <div
                className="mt-7 mb-2 grid gap-3.5"
                style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min ?? 230}px, 1fr))` }}
            >
                {stats.map((s) => (
                    <div
                        key={s.label}
                        className="min-w-0 rounded-[14px] border border-line bg-panel px-[18px] py-4 transition-[translate,box-shadow] duration-200 motion-safe:hover:-translate-y-0.5 hover:shadow-[var(--glow)]"
                        style={{
                            borderBottom: `3px solid ${s.color ?? (s.edge ? TONE_VAR[s.edge] : "var(--accent)")}`,
                        }}
                    >
                        <div
                            className={`font-display text-[28px] font-bold leading-[1.1] tabular-nums ${s.tone ? TONE_TEXT[s.tone] : "text-ink"}`}
                        >
                            {withDimArrows(s.value)}
                        </div>
                        {s.delta ? <StatDeltaLine delta={s.delta} /> : null}
                        <div className="mt-1.5 text-[15px] text-ink-2">{s.label}</div>
                        {s.hint ? <div className="mt-1 text-sm text-dim">{renderBody(s.hint)}</div> : null}
                    </div>
                ))}
            </div>
        );
    }

    const compact = min !== undefined || stats.some((s) => s.delta || s.edge || s.color);

    if (compact) {
        return (
            <div
                className="grid gap-[10px]"
                style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min ?? 170}px, 1fr))` }}
            >
                {stats.map((s) => (
                    <div
                        key={s.label}
                        className="min-w-0 rounded-[8px] border border-line bg-panel/60 px-[14px] py-3"
                        style={
                            s.edge || s.color
                                ? {
                                      borderLeftWidth: 3,
                                      borderLeftStyle: "solid",
                                      borderLeftColor: s.color ?? TONE_VAR[s.edge ?? "neutral"],
                                  }
                                : undefined
                        }
                    >
                        <div className="text-[11px] text-dim">{s.label}</div>
                        <div
                            className={`text-[23px] font-[650] tracking-tight tabular-nums ${s.tone ? TONE_TEXT[s.tone] : "text-ink"}`}
                        >
                            {s.value}
                        </div>
                        {s.delta ? <StatDeltaLine delta={s.delta} /> : null}
                        {s.hint ? <div className="mt-1 text-[0.7rem] text-dim">{renderBody(s.hint)}</div> : null}
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {stats.map((s) => (
                <div key={s.label} className="rounded-card border border-line bg-panel/60 p-4">
                    <div className={`font-mono text-2xl tracking-tight ${TONE_TEXT[s.tone ?? "neutral"]}`}>
                        {s.value}
                    </div>
                    <div className="mt-0.5 text-xs text-dim">{s.label}</div>
                    {s.hint ? <div className="mt-1 text-[0.7rem] text-dim">{renderBody(s.hint)}</div> : null}
                </div>
            ))}
        </div>
    );
}

export interface CodeBlockProps {
    children: string;
    /** Shown as a small header row when set. */
    label?: string;
    /** Syntax highlighting (`ts`, `swift`, `bash`, `json`, `sql`, …). Unknown names render plain. */
    lang?: string;
    wrap?: boolean;
    /** Copy-to-clipboard button (default on — cited code exists to be copied). */
    copy?: boolean;
    /** 1-based lines to mark as load-bearing (accent tint). */
    highlightLines?: number[];
    /** 1-based lines to mark as the problem (err tint). */
    badLines?: number[];
}

/** Escaped, highlighted HTML for one line or the whole block; null when `lang` is unknown. */
function litHtml(code: string, lang: string | undefined): string | null {
    return lang ? (highlightCode(code, lang)?.html ?? null) : null;
}

/**
 * Preformatted code / log block with copy, line marking and optional syntax
 * highlighting. Marked blocks highlight line by line, so a construct that
 * spans lines (a block comment) may lose its color past the first line.
 */
export function CodeBlock({
    children,
    label,
    lang,
    wrap = false,
    copy = true,
    highlightLines,
    badLines,
}: CodeBlockProps) {
    const [copied, setCopied] = useState(false);
    const isDocument = usePageLook() === "document";
    const marked = (highlightLines?.length ?? 0) + (badLines?.length ?? 0) > 0;
    const wholeHtml = marked ? null : litHtml(children, lang);
    const onCopy = (): void => {
        // navigator.clipboard is undefined in non-secure contexts (plain http
        // on a non-loopback host) — the property access itself would throw.
        if (!navigator.clipboard) {
            setCopied(false);

            return;
        }

        navigator.clipboard
            .writeText(children)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => setCopied(false));
    };

    return (
        <div className={`group relative overflow-hidden rounded-card border border-line ${isDocument ? "" : "my-3"}`}>
            {label ? (
                <div className="border-b border-line bg-panel px-3 py-1 font-mono text-[0.7rem] text-dim">{label}</div>
            ) : null}
            {copy ? (
                <button
                    type="button"
                    onClick={onCopy}
                    className="absolute right-2 top-2 rounded-card border border-line bg-panel/90 px-2 py-0.5 font-mono text-[0.68rem] text-dim opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 hover:border-accent hover:text-ink"
                >
                    {copied ? "copied" : "copy"}
                </button>
            ) : null}
            <pre
                className={`overflow-x-auto bg-canvas/80 font-mono text-ink/90 ${isDocument ? "px-[18px] py-4 text-[14.5px] leading-[1.65]" : "p-3 text-[0.82rem] leading-relaxed"} ${wrap ? "whitespace-pre-wrap" : ""}`}
            >
                {marked ? (
                    children.split("\n").map((line, i) => {
                        const no = i + 1;
                        const cls = badLines?.includes(no)
                            ? "block bg-err/15 text-err"
                            : highlightLines?.includes(no)
                              ? "block bg-accent/10"
                              : "block";
                        const lineHtml = line ? litHtml(line, lang) : null;

                        if (lineHtml !== null) {
                            return (
                                <span
                                    key={no}
                                    className={`${cls} hljs`}
                                    // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output, escaped by the highlighter
                                    dangerouslySetInnerHTML={{ __html: lineHtml }}
                                />
                            );
                        }

                        return (
                            <span key={no} className={cls}>
                                {line || " "}
                            </span>
                        );
                    })
                ) : wholeHtml !== null ? (
                    <code
                        className="hljs"
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output, escaped by the highlighter
                        dangerouslySetInnerHTML={{ __html: wholeHtml }}
                    />
                ) : (
                    children
                )}
            </pre>
        </div>
    );
}

/** One definition row of a Card: a short label and its value (a string is inline markdown). */
export interface CardField {
    k: string;
    v: BodyContent;
}

export interface CardProps {
    title?: string;
    tone?: Tone;
    /** Accent colour (any CSS colour) for the edge, the kicker and the number; wins over `tone`. */
    color?: string;
    /** Side that carries the accent edge: 3 px, or 4 px at the bottom. Default "top" when `color` is set. */
    edge?: "top" | "bottom" | "left" | "none";
    /** Small mono label above the title, in the accent colour ("phase 1"). */
    kicker?: string;
    /** Large number before the title, in the accent colour. */
    number?: string | number;
    /** Dim line under the title: what kind of thing the card is. */
    subtitle?: string;
    /** Title in the mono face (a command, a path). */
    mono?: boolean;
    /** Ghost card on a dashed border and the nested surface: something proposed, not there yet. */
    dashed?: boolean;
    /** Tilt in degrees for a scattered wall; the card straightens and lifts on hover. */
    tilt?: number;
    /** Lift and glow on hover. */
    lift?: boolean;
    /** A constant accent glow: the card the page points at. */
    highlight?: boolean;
    /** Quieter tier: the nested surface and a smaller title. */
    muted?: boolean;
    /** Definition rows under the title. */
    fields?: CardField[];
    /** Mono lines (commands, flags); a line may mix text and tags. */
    lines?: ReactNode[];
    children?: BodyContent;
    /** Highlighted line under the body, in `noteTone` (default ok). */
    note?: BodyContent;
    noteTone?: Tone;
    /** Row at the bottom (tags, links). */
    footer?: ReactNode;
}

const EDGE_WIDTH: Record<"top" | "bottom" | "left", number> = { top: 3, bottom: 4, left: 3 };

function cardEdgeStyle(side: "top" | "bottom" | "left", accent: string): CSSProperties {
    const border = `${EDGE_WIDTH[side]}px solid ${accent}`;

    if (side === "top") {
        return { borderTop: border };
    }

    return side === "bottom" ? { borderBottom: border } : { borderLeft: border };
}

/** Neutral panel between Section (page-level) and Callout (highlight). Its optional parts build richer cards: an accent edge, a kicker or number, definition rows, mono lines, a footer of tags. */
export function Card(props: CardProps) {
    const { title, tone, color, kicker, number, subtitle, mono, dashed, tilt, lift, highlight, muted } = props;
    const { fields, lines, children, note, noteTone = "ok", footer } = props;
    const look = usePageLook();
    const rich =
        look === "document" ||
        [
            color,
            props.edge,
            kicker,
            number,
            subtitle,
            mono,
            dashed,
            tilt,
            lift,
            highlight,
            muted,
            fields,
            lines,
            note,
            footer,
        ].some((part) => part !== undefined && part !== false);

    if (!rich) {
        const border = tone ? TONE_BORDER[tone] : "border-line";

        return (
            <div className={`rounded-card border ${border} bg-panel/60 p-4`}>
                {title ? (
                    <h3 className={`mb-2 font-semibold ${tone ? TONE_TEXT[tone] : "text-ink"}`}>{title}</h3>
                ) : null}
                <div className="text-[0.95rem] text-ink/90">{renderBody(children)}</div>
            </div>
        );
    }

    const accent = color ?? (tone ? TONE_VAR[tone] : dashed ? "var(--dim)" : "var(--border-2)");
    const edge = props.edge ?? (color ? "top" : "none");
    const style: CssVarStyle = {
        ...(edge === "none" ? {} : cardEdgeStyle(edge, accent)),
        ...(tilt ? { "--tilt": `${tilt}deg` } : {}),
    };
    // Reduced motion: the tilt stays as drawn and the card never moves; the glow and border still answer the pointer.
    const motion = tilt
        ? "rotate-[var(--tilt)] motion-safe:hover:rotate-0 motion-safe:hover:-translate-y-[3px] motion-safe:hover:scale-[1.01] hover:border-line-2 hover:shadow-[var(--glow)]"
        : lift
          ? "motion-safe:hover:-translate-y-[3px] hover:shadow-[var(--glow)]"
          : "";
    const surface = dashed || muted ? "bg-panel-2" : look === "document" ? "bg-panel" : "bg-panel/60";
    const border = dashed ? "border-dashed border-line" : tone && !color ? TONE_BORDER[tone] : "border-line";
    const titleClass = mono
        ? "font-mono text-[15.5px] font-semibold leading-[normal]"
        : muted
          ? "font-display text-[15px] font-semibold leading-[normal]"
          : "font-display text-[16.5px] font-semibold leading-[1.3]";
    const headGap = subtitle ? "" : number !== undefined ? "mb-2" : muted ? "mb-1" : "mb-1.5";

    return (
        <div
            className={`relative min-w-0 rounded-card border ${border} ${surface} ${mono || muted ? "px-3.5 py-3" : "px-4 py-3.5"} ${highlight ? "shadow-[var(--glow)]" : ""} ${motion} transition-[rotate,translate,scale,box-shadow,border-color] duration-200 ease-out`}
            style={style}
        >
            {kicker ? (
                <div className="font-mono text-[15px] font-bold leading-[normal]" style={{ color: accent }}>
                    {kicker}
                </div>
            ) : null}
            {number !== undefined || title ? (
                <div className={`flex items-baseline gap-2.5 ${kicker ? "mt-1" : ""} ${headGap}`}>
                    {number !== undefined ? (
                        <span
                            className="min-w-[34px] font-display text-[22px] font-bold leading-[normal]"
                            style={{ color: accent }}
                        >
                            {number}
                        </span>
                    ) : null}
                    {title ? (
                        <h3 className={`${titleClass} ${tone && !color ? TONE_TEXT[tone] : "text-ink"}`}>{title}</h3>
                    ) : null}
                </div>
            ) : null}
            {subtitle ? <div className="mt-0.5 mb-1.5 text-[14px] text-dim">{subtitle}</div> : null}
            {fields?.length ? (
                <dl className="grid grid-cols-[74px_1fr] gap-x-2.5 gap-y-1 text-[14.5px]">
                    {fields.map((field) => (
                        <div key={field.k} className="contents">
                            <dt className="font-mono text-sm font-medium leading-[normal] text-dim">{field.k}</dt>
                            <dd className="min-w-0 text-ink-2 [&_code]:text-ink">
                                {typeof field.v === "string" ? <MdInline>{field.v}</MdInline> : field.v}
                            </dd>
                        </div>
                    ))}
                </dl>
            ) : null}
            {lines?.length ? (
                <ul className="font-mono text-[14.5px] leading-[1.55] text-ink-2">
                    {lines.map((line, i) => (
                        <li key={i} className="py-px">
                            {line}
                        </li>
                    ))}
                </ul>
            ) : null}
            {children !== undefined && children !== null ? (
                <div className={`text-[15px] text-ink-2 ${muted ? "leading-[1.7]" : ""}`}>{renderBody(children)}</div>
            ) : null}
            {note ? <div className={`mt-2 text-[14px] ${TONE_TEXT[noteTone]}`}>{renderBody(note)}</div> : null}
            {footer ? <div className="mt-2.5 flex flex-wrap gap-1.5">{footer}</div> : null}
        </div>
    );
}

export interface CardGridProps {
    columns?: 2 | 3;
    /** Minimum card width in px: as many columns as fit (`repeat(auto-fit, minmax(min, 1fr))`); wins over `columns`. */
    min?: number;
    /** With `min`: keep the empty tracks (auto-fill), so a filtered grid keeps its column width. */
    fill?: boolean;
    children: ReactNode;
}

/** Responsive grid of Cards (the "two-card row" every dashboard hand-rolled). */
export function CardGrid({ columns = 2, min, fill = false, children }: CardGridProps) {
    if (min !== undefined) {
        return (
            <div
                className="mt-4 grid gap-3.5 first:mt-0"
                style={{
                    gridTemplateColumns: `repeat(${fill ? "auto-fill" : "auto-fit"}, minmax(min(${min}px, 100%), 1fr))`,
                }}
            >
                {children}
            </div>
        );
    }

    return <div className={`my-4 grid gap-4 ${columns === 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>{children}</div>;
}

export interface ClaimProps {
    /** Confidence percentage (0-100); renders the [NN%] badge. */
    confidence?: number;
    tone?: Tone;
    children: BodyContent;
    /** Optional grounds/proof line under the statement. */
    proof?: BodyContent;
}

/** A load-bearing claim: [NN%] badge + statement + optional proof line. */
export function Claim({ confidence, tone, children, proof }: ClaimProps) {
    const derived: Tone =
        tone ?? (confidence === undefined ? "neutral" : confidence >= 85 ? "ok" : confidence >= 60 ? "warn" : "err");

    return (
        <div className="my-2">
            <div className="flex items-baseline gap-2">
                {confidence !== undefined ? <Badge tone={derived}>{confidence}%</Badge> : null}
                <div className="min-w-0 flex-1 text-ink/90">{renderBody(children)}</div>
            </div>
            {proof ? <div className="mt-1 pl-1 text-sm text-dim">{renderBody(proof)}</div> : null}
        </div>
    );
}

export interface QuoteProps {
    children: BodyContent;
    /** Attribution (name, source). */
    cite?: string;
    tone?: Tone;
}

/** Attributed quotation. */
export function Quote({ children, cite, tone = "neutral" }: QuoteProps) {
    return (
        <figure className={`my-3 border-l-2 ${tone === "neutral" ? "border-accent" : TONE_BORDER[tone]} pl-3`}>
            <blockquote className="text-ink/90">{renderBody(children)}</blockquote>
            {cite ? <figcaption className="mt-1 text-xs text-dim">{cite}</figcaption> : null}
        </figure>
    );
}

export interface NoteProps {
    children: BodyContent;
}

/** Muted aside prose. */
export function Note({ children }: NoteProps) {
    return <div className="my-2 text-sm text-dim">{renderBody(children)}</div>;
}

export interface SupersededProps {
    /** Why it was retracted/replaced. */
    reason?: string;
    children: ReactNode;
}

/** Retracted content kept for the audit trail — visibly marked, not just dimmed. */
export function Superseded({ reason, children }: SupersededProps) {
    return (
        <div className="my-3 rounded-card border border-line/60 p-3 opacity-60">
            <div className="mb-1 font-mono text-[0.7rem] uppercase tracking-wider text-warn">
                superseded{reason ? ` — ${reason}` : ""}
            </div>
            {children}
        </div>
    );
}

export interface FileMarkProps {
    path: string;
    /** Line or line range, e.g. "11-14". */
    lines?: string;
    badge?: string;
    tone?: Tone;
}

/** file:line reference chip. */
export function FileMark({ path, lines, badge, tone = "neutral" }: FileMarkProps) {
    return (
        <span className="inline-flex items-baseline gap-1.5 rounded-card border border-line bg-panel px-2 py-0.5 font-mono text-[0.78rem]">
            <span className="text-ink/90">
                {path}
                {lines ? `:${lines}` : ""}
            </span>
            {badge ? <Badge tone={tone}>{badge}</Badge> : null}
        </span>
    );
}

export interface SegmentedOption {
    value: string;
    label: string;
}

export interface SegmentedControlProps {
    options: SegmentedOption[];
    value: string;
    onChange: (value: string) => void;
    label?: string;
}

/**
 * Pick-one segmented control (drives simulators, filters, mode switches).
 *
 * The group is a `radiogroup` rather than a row of buttons: which option is
 * active was carried only by the accent fill, so a screen reader heard three
 * ordinary buttons and nothing about the current mode. `aria-checked` states it,
 * and the optional visual label is tied to the group through `aria-labelledby`
 * instead of merely sitting next to it.
 */
export function SegmentedControl({ options, value, onChange, label }: SegmentedControlProps) {
    const labelId = useId();

    return (
        <div className="inline-flex items-center gap-2">
            {label ? (
                <span id={labelId} className="text-xs text-dim">
                    {label}
                </span>
            ) : null}
            <div
                role="radiogroup"
                aria-labelledby={label ? labelId : undefined}
                className="inline-flex overflow-hidden rounded-card border border-line"
            >
                {options.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={option.value === value}
                        onClick={() => onChange(option.value)}
                        className={
                            option.value === value
                                ? "bg-accent/15 px-3 py-1 text-sm font-medium text-accent"
                                : "px-3 py-1 text-sm text-dim transition-colors hover:bg-panel hover:text-ink"
                        }
                    >
                        {option.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
