import type { ReactNode } from "react";
export type Tone = "ok" | "warn" | "err" | "info" | "neutral";
export declare const TONE_TEXT: Record<Tone, string>;
export declare const TONE_BORDER: Record<Tone, string>;
export declare const TONE_BG: Record<Tone, string>;
/** Body prop shared across the kit: a markdown string or ready-made nodes. */
export type BodyContent = string | ReactNode;
export declare function renderBody(body: BodyContent | undefined): ReactNode;
export interface PageProps {
    children: ReactNode;
    /** Max content width utility. */
    width?: string;
}
/** Root wrapper: dark canvas, sane typography. Wrap every artifact in one Page. */
export declare function Page({ children, width }: PageProps): import("react/jsx-runtime").JSX.Element;
export interface HeroProps {
    /** Small uppercase context label above the title. */
    kicker?: string;
    title: string;
    subtitle?: BodyContent;
    chips?: ChipItem[];
    children?: ReactNode;
}
/** Page header: kicker, display title, intro, meta chips. */
export declare function Hero({
    kicker,
    title,
    subtitle,
    chips,
    children,
}: HeroProps): import("react/jsx-runtime").JSX.Element;
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
export declare function Chips({ items, className }: ChipsProps): import("react/jsx-runtime").JSX.Element;
export interface BadgeProps {
    tone?: Tone;
    children: ReactNode;
}
/** Inline status/verdict badge. */
export declare function Badge({ tone, children }: BadgeProps): import("react/jsx-runtime").JSX.Element;
export interface CalloutProps {
    tone?: Tone;
    title?: string;
    children: BodyContent;
}
/** Highlighted box for verdicts, warnings, and summaries. */
export declare function Callout({ tone, title, children }: CalloutProps): import("react/jsx-runtime").JSX.Element;
export interface SectionProps {
    title: string;
    /** Optional side note shown right of the title. */
    note?: string;
    children: ReactNode;
}
/** Labeled content section. */
export declare function Section({ title, note, children }: SectionProps): import("react/jsx-runtime").JSX.Element;
export interface StatItem {
    label: string;
    value: string;
    tone?: Tone;
    /** Optional one-line detail under the label. */
    hint?: string;
}
export interface StatGridProps {
    stats: StatItem[];
}
/** Row of headline numbers. */
export declare function StatGrid({ stats }: StatGridProps): import("react/jsx-runtime").JSX.Element;
export interface CodeBlockProps {
    children: string;
    /** Shown as a small header row when set. */
    label?: string;
    wrap?: boolean;
}
/** Preformatted code / log block. */
export declare function CodeBlock({ children, label, wrap }: CodeBlockProps): import("react/jsx-runtime").JSX.Element;
