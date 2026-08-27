import { type ReactNode, useState } from "react";
import { Md } from "./md";

export type Tone = "ok" | "warn" | "err" | "info" | "neutral";

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
    /** Max content width utility. */
    width?: string;
}

/** Root wrapper: dark canvas, sane typography. Wrap every artifact in one Page. */
export function Page({ children, width = "max-w-6xl" }: PageProps) {
    return (
        <div className="min-h-dvh bg-canvas px-4 py-8 font-sans text-ink sm:px-6">
            <main className={`${width} mx-auto`}>{children}</main>
        </div>
    );
}

export interface HeroProps {
    /** Small uppercase context label above the title. */
    kicker?: string;
    title: string;
    subtitle?: BodyContent;
    chips?: ChipItem[];
    children?: ReactNode;
}

/** Page header: kicker, display title, intro, meta chips. */
export function Hero({ kicker, title, subtitle, chips, children }: HeroProps) {
    return (
        <header className="mb-8">
            {kicker ? (
                <div className="mb-1 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-dim">{kicker}</div>
            ) : null}
            <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{title}</h1>
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

export interface BadgeProps {
    tone?: Tone;
    /** Saturated rounded pill (deep tone fill, no border) — the status-chip look. */
    pill?: boolean;
    children: ReactNode;
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
export function Badge({ tone = "neutral", pill = false, children }: BadgeProps) {
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

export interface CalloutProps {
    tone?: Tone;
    title?: string;
    children: BodyContent;
}

/** Highlighted box for verdicts, warnings, and summaries. */
export function Callout({ tone = "info", title, children }: CalloutProps) {
    return (
        <div className={`my-4 rounded-card border p-4 ${TONE_BORDER[tone]} ${TONE_BG[tone]}`}>
            {title ? <div className={`mb-1 font-semibold ${TONE_TEXT[tone]}`}>{title}</div> : null}
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
                    <span className="text-dim transition-transform group-open:rotate-90">▸</span>
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
    children: ReactNode;
}

/** Labeled content section. */
export function Section({ title, note, children }: SectionProps) {
    return (
        <section className="mt-10 first:mt-0">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
                <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
                {note ? <span className="text-xs text-dim">{note}</span> : null}
            </div>
            {children}
        </section>
    );
}

export interface StatItem {
    label: string;
    value: string;
    tone?: Tone;
    /** Optional one-line detail under the label (markdown string or nodes). */
    hint?: BodyContent;
}

export interface StatGridProps {
    stats: StatItem[];
}

/** Row of headline numbers. */
export function StatGrid({ stats }: StatGridProps) {
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
    wrap?: boolean;
    /** Copy-to-clipboard button (default on — cited code exists to be copied). */
    copy?: boolean;
    /** 1-based lines to mark as load-bearing (accent tint). */
    highlightLines?: number[];
    /** 1-based lines to mark as the problem (err tint). */
    badLines?: number[];
}

/** Preformatted code / log block with copy + line marking. */
export function CodeBlock({ children, label, wrap = false, copy = true, highlightLines, badLines }: CodeBlockProps) {
    const [copied, setCopied] = useState(false);
    const marked = (highlightLines?.length ?? 0) + (badLines?.length ?? 0) > 0;
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
        <div className="group relative my-3 overflow-hidden rounded-card border border-line">
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
            {marked ? (
                <pre
                    className={`overflow-x-auto bg-canvas/80 p-3 font-mono text-[0.82rem] leading-relaxed text-ink/90 ${wrap ? "whitespace-pre-wrap" : ""}`}
                >
                    {children.split("\n").map((line, i) => {
                        const no = i + 1;
                        const cls = badLines?.includes(no)
                            ? "block bg-err/15 text-err"
                            : highlightLines?.includes(no)
                              ? "block bg-accent/10"
                              : "block";

                        return (
                            <span key={no} className={cls}>
                                {line || " "}
                            </span>
                        );
                    })}
                </pre>
            ) : (
                <pre
                    className={`overflow-x-auto bg-canvas/80 p-3 font-mono text-[0.82rem] leading-relaxed text-ink/90 ${wrap ? "whitespace-pre-wrap" : ""}`}
                >
                    {children}
                </pre>
            )}
        </div>
    );
}

export interface CardProps {
    title?: string;
    tone?: Tone;
    children: BodyContent;
}

/** Neutral panel between Section (page-level) and Callout (highlight). */
export function Card({ title, tone, children }: CardProps) {
    const border = tone ? TONE_BORDER[tone] : "border-line";

    return (
        <div className={`rounded-card border ${border} bg-panel/60 p-4`}>
            {title ? <h3 className={`mb-2 font-semibold ${tone ? TONE_TEXT[tone] : "text-ink"}`}>{title}</h3> : null}
            <div className="text-[0.95rem] text-ink/90">{renderBody(children)}</div>
        </div>
    );
}

export interface CardGridProps {
    columns?: 2 | 3;
    children: ReactNode;
}

/** Responsive grid of Cards (the "two-card row" every dashboard hand-rolled). */
export function CardGrid({ columns = 2, children }: CardGridProps) {
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

/** Pick-one segmented control (drives simulators, filters, mode switches). */
export function SegmentedControl({ options, value, onChange, label }: SegmentedControlProps) {
    return (
        <div className="inline-flex items-center gap-2">
            {label ? <span className="text-xs text-dim">{label}</span> : null}
            <div className="inline-flex overflow-hidden rounded-card border border-line">
                {options.map((option) => (
                    <button
                        key={option.value}
                        type="button"
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
