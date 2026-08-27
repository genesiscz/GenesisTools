import { type ReactNode, useMemo, useState } from "react";
import { MdInline } from "./md";
import {
    Badge,
    type BodyContent,
    type ChipItem,
    Chips,
    renderBody,
    TONE_BG,
    TONE_DOT,
    TONE_TEXT,
    type Tone,
} from "./primitives";

export interface TabItem {
    id: string;
    label: string;
    /** Status pill rendered after the label (e.g. MERGED, OPEN, OUR BUG). */
    badge?: { text: string; tone?: Tone };
    content: ReactNode;
}

export interface TabsProps {
    tabs: TabItem[];
    /** Initial tab id (default: first, or the location hash). */
    initial?: string;
    /** Pin the tab bar to the top while the panel scrolls (default true). */
    sticky?: boolean;
    /** One-line bar that scrolls horizontally instead of wrapping (default: wrap to multiple lines). */
    scroll?: boolean;
}

/** Tab bar + panels. The active tab syncs to the URL hash, so tabs are linkable. */
export function Tabs({ tabs, initial, sticky = true, scroll = false }: TabsProps) {
    const fromHash = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    const start = tabs.some((t) => t.id === fromHash) ? fromHash : (initial ?? tabs[0]?.id);
    const [active, setActive] = useState(start);
    const current = tabs.find((t) => t.id === active) ?? tabs[0];

    return (
        <div>
            <div
                className={`mb-6 flex gap-1 border-b border-line ${
                    scroll ? "flex-nowrap overflow-x-auto [scrollbar-width:thin]" : "flex-wrap"
                } ${sticky ? "sticky top-0 z-20 bg-canvas/95 pt-1 backdrop-blur-sm" : ""}`}
            >
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                            setActive(t.id);
                            history.replaceState(null, "", `#${t.id}`);
                        }}
                        className={`${scroll ? "shrink-0 " : ""}${
                            t.id === current?.id
                                ? "inline-flex items-center gap-1.5 rounded-t-card border border-b-0 border-line bg-panel px-4 py-2 text-sm font-medium text-ink"
                                : "inline-flex items-center gap-1.5 rounded-t-card px-4 py-2 text-sm text-dim transition-colors hover:bg-panel/60 hover:text-ink"
                        }`}
                    >
                        {t.label}
                        {t.badge ? (
                            <Badge tone={t.badge.tone ?? "neutral"} pill>
                                {t.badge.text}
                            </Badge>
                        ) : null}
                    </button>
                ))}
            </div>
            {current?.content}
        </div>
    );
}

export interface TimelineEntry {
    time: string;
    /** Optional headline; body-only entries (attribution stamp + paragraph) omit it. */
    title?: string;
    body?: BodyContent;
    tone?: Tone;
}

export interface TimelineProps {
    entries: TimelineEntry[];
}

/** Vertical timeline with tone-colored markers. */
export function Timeline({ entries }: TimelineProps) {
    return (
        <ol className="relative ml-2 border-l border-line pl-6">
            {entries.map((e, i) => (
                <li key={`${e.time}-${i}`} className="relative mb-6 last:mb-0">
                    <span
                        className={`absolute -left-[1.85rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-canvas ${TONE_DOT[e.tone ?? "neutral"]}`}
                    />
                    <div className="font-mono text-xs text-dim">{e.time}</div>
                    {e.title ? <div className={`font-medium ${TONE_TEXT[e.tone ?? "neutral"]}`}>{e.title}</div> : null}
                    {e.body ? <div className="mt-1 text-sm text-dim">{renderBody(e.body)}</div> : null}
                </li>
            ))}
        </ol>
    );
}

export interface DataTableColumn {
    key: string;
    label: string;
    /** Right-align + monospace (numbers, ids). */
    mono?: boolean;
}

/** A cell: plain value, ready node, or a toned/markdown-aware object. */
export type DataTableCell = string | number | ReactNode | { text: string; tone?: Tone; md?: boolean; mono?: boolean };

function isCellObject(cell: DataTableCell): cell is { text: string; tone?: Tone; md?: boolean; mono?: boolean } {
    return typeof cell === "object" && cell !== null && "text" in (cell as Record<string, unknown>);
}

function cellText(cell: DataTableCell): string | null {
    if (typeof cell === "string" || typeof cell === "number") {
        return String(cell);
    }

    return isCellObject(cell) ? cell.text : null;
}

export interface DataTableProps {
    columns: DataTableColumn[];
    rows: Array<Record<string, DataTableCell>>;
    /** Show a text filter box (matches searchable cells). */
    filter?: boolean;
    caption?: string;
    /** Row tint (claim/verdict tables): return a Tone for a row, or undefined. */
    /** Row highlight. Receives the row exactly as passed in `rows` — i.e. AFTER any
     * cell-object mapping you did — so read tones back out of your own cell shapes. */
    rowTone?: (row: Record<string, DataTableCell>, index: number) => Tone | undefined;
    /** Render string cells as inline markdown (extracted data carries bold and code spans). */
    markdown?: boolean;
}

/** Data table with optional filtering, row tones, and markdown cells. */
export function DataTable({ columns, rows, filter = false, caption, rowTone, markdown = false }: DataTableProps) {
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const unsearchable = useMemo(
        () => columns.filter((c) => rows.some((row) => cellText(row[c.key]) === null && row[c.key] !== undefined)),
        [columns, rows]
    );
    const visible = useMemo(() => {
        if (!q) {
            return rows;
        }

        return rows.filter((row) => columns.some((c) => cellText(row[c.key])?.toLowerCase().includes(q) ?? false));
    }, [rows, columns, q]);

    const renderCell = (cell: DataTableCell): ReactNode => {
        if (isCellObject(cell)) {
            const inner = (cell.md ?? markdown) ? <MdInline>{cell.text}</MdInline> : cell.text;
            const toned = cell.tone ? <span className={TONE_TEXT[cell.tone]}>{inner}</span> : inner;

            return cell.mono ? <span className="font-mono text-[0.82rem]">{toned}</span> : toned;
        }

        if (typeof cell === "string" && markdown) {
            return <MdInline>{cell}</MdInline>;
        }

        return cell as ReactNode;
    };

    return (
        <div className="my-3">
            {filter ? (
                <div className="mb-2 flex items-center gap-2">
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="filter rows…"
                        className="w-60 max-w-full rounded-card border border-line bg-panel px-3 py-1.5 text-sm outline-none focus:border-accent"
                    />
                    <span className="text-xs text-dim">
                        {visible.length}/{rows.length}
                        {q && unsearchable.length > 0 ? ` (${unsearchable.length} column(s) not searchable)` : ""}
                    </span>
                </div>
            ) : null}
            <div className="overflow-x-auto rounded-card border border-line">
                <table className="w-full text-sm">
                    {caption ? <caption className="p-2 text-left text-xs text-dim">{caption}</caption> : null}
                    <thead>
                        <tr className="bg-panel text-left text-xs uppercase tracking-wider text-dim">
                            {columns.map((c) => (
                                <th key={c.key} className={`px-3 py-2 font-semibold ${c.mono ? "text-right" : ""}`}>
                                    {c.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((row, i) => {
                            const tone = rowTone?.(row, i);

                            return (
                                <tr key={i} className={`border-t border-line/70 ${tone ? TONE_BG[tone] : ""}`}>
                                    {columns.map((c) => (
                                        <td
                                            key={c.key}
                                            className={`px-3 py-1.5 align-top ${c.mono ? "text-right font-mono text-[0.82rem]" : ""}`}
                                        >
                                            {renderCell(row[c.key])}
                                        </td>
                                    ))}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export interface BulletsProps {
    items: Array<string | { text: string; tone?: Tone; confidence?: number; sub?: BodyContent }>;
    ordered?: boolean;
}

/** List primitive with per-item tone, confidence badge, and sub-lines. */
export function Bullets({ items, ordered = false }: BulletsProps) {
    const ListTag = ordered ? "ol" : "ul";

    return (
        <ListTag className={`my-2 space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
            {items.map((item, i) => {
                const obj = typeof item === "string" ? { text: item } : item;

                return (
                    <li key={i} className={obj.tone ? TONE_TEXT[obj.tone] : "text-ink/90"}>
                        {obj.confidence !== undefined ? (
                            <span className="mr-1.5">
                                <Badge tone={obj.tone ?? "neutral"}>{obj.confidence}%</Badge>
                            </span>
                        ) : null}
                        <MdInline className="text-inherit">{obj.text}</MdInline>
                        {obj.sub ? <div className="mt-0.5 text-sm text-dim">{renderBody(obj.sub)}</div> : null}
                    </li>
                );
            })}
        </ListTag>
    );
}

export interface SeriesTableProps {
    labels: string[];
    series: Array<{ label: string; data: number[]; tone?: Tone }>;
    caption?: string;
    /** Marker column highlight, e.g. the deploy day. */
    marker?: { at: number; label: string };
}

/** Chart fallback: labeled numeric series as a compact stats row + table. */
export function SeriesTable({ labels, series, caption, marker }: SeriesTableProps) {
    return (
        <div className="my-3">
            <div className="mb-2 flex flex-wrap gap-4">
                {series.map((s) => {
                    const max = Math.max(...s.data);
                    const last = s.data[s.data.length - 1];

                    return (
                        <div key={s.label} className="text-xs text-dim">
                            <span className={`font-medium ${s.tone ? TONE_TEXT[s.tone] : "text-ink"}`}>{s.label}</span>{" "}
                            <span className="font-mono">
                                max {max.toLocaleString()} · last {last?.toLocaleString()}
                            </span>
                        </div>
                    );
                })}
            </div>
            <DataTable
                caption={caption ?? (marker ? `${marker.label} at ${labels[marker.at]}` : undefined)}
                columns={[
                    { key: "label", label: "" },
                    ...labels.map((l, i) => ({
                        key: `c${i}`,
                        label: marker?.at === i ? `${l} ◆` : l,
                        mono: true,
                    })),
                ]}
                rows={series.map((s) => {
                    const row: Record<string, DataTableCell> = {
                        label: { text: s.label, tone: s.tone },
                    };

                    s.data.forEach((v, i) => {
                        row[`c${i}`] = String(v);
                    });

                    return row;
                })}
            />
        </div>
    );
}

export interface QaItem {
    q: string;
    a: BodyContent;
    verdict?: string;
    tone?: Tone;
    /** Start this item expanded (overrides the list-level default). */
    open?: boolean;
    /** Featured item: warn-tinted question row (the headline question). */
    featured?: boolean;
    /** Meta chips visible while collapsed (kind, topic, when). */
    meta?: ChipItem[];
}

export interface QaProps {
    items: QaItem[];
    /** Open every answer initially (default: collapsed). */
    open?: boolean;
}

/** Question/answer list with verdict badges, per-item open/featured, and meta chips. */
export function QA({ items, open = false }: QaProps) {
    return (
        <div className="my-3 space-y-2">
            {items.map((item, i) => (
                <details
                    key={i}
                    open={item.open ?? open}
                    className={`group rounded-card border bg-panel/40 open:bg-panel/70 ${
                        item.featured ? "border-warn/50" : "border-line"
                    }`}
                >
                    <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-2 px-4 py-2.5 font-medium marker:hidden">
                        <span className="font-mono text-xs text-dim transition-transform group-open:rotate-90">▸</span>
                        <span className={`flex-1 ${item.featured ? "text-warn" : ""}`}>{item.q}</span>
                        {item.meta?.length ? <Chips items={item.meta} /> : null}
                        {item.verdict ? <Badge tone={item.tone ?? "neutral"}>{item.verdict}</Badge> : null}
                    </summary>
                    <div className="border-t border-line px-4 py-3 text-sm text-ink/90">{renderBody(item.a)}</div>
                </details>
            ))}
        </div>
    );
}
