// Inner-content renderers for the AI expression layer's card kinds (payload.layer "ai"). Parity
// of information, not pixel-perfection (plan decision §0.1.9) — CardView.tsx owns position/drag/
// selection chrome and just delegates to these for the card BODY.
import type { PointerEvent as ReactPointerEvent } from "react";
import { renderMdLite } from "./md-lite";

type Payload = Record<string, unknown>;

function str(payload: Payload, key: string): string {
    return typeof payload[key] === "string" ? (payload[key] as string) : "";
}

function num(payload: Payload, key: string): number | undefined {
    return typeof payload[key] === "number" ? (payload[key] as number) : undefined;
}

const ROLE_ACCENT: Record<string, string> = {
    heading: "border-l-4 border-[var(--dd-accent-from)]",
    idea: "border-l-4 border-sky-400",
    pro: "border-l-4 border-emerald-400",
    con: "border-l-4 border-[var(--dd-danger)]",
    risk: "border-l-4 border-[var(--dd-warning)]",
};

/** kind "text": md-lite render with a left accent strip when payload.role is set. */
export function TextCard({ payload }: { payload: Payload }) {
    const role = str(payload, "role");
    const accent = ROLE_ACCENT[role] ?? "";
    return <div className={`h-full w-full overflow-auto p-1 pl-2 ${accent}`}>{renderMdLite(str(payload, "md"))}</div>;
}

const CALLOUT_TONE: Record<string, string> = {
    info: "border-sky-400 bg-sky-400/10",
    warn: "border-[var(--dd-warning)] bg-[var(--dd-warning)]/10",
    success: "border-emerald-400 bg-emerald-400/10",
    decision: "border-violet-400 bg-violet-400/10",
};

/** kind "callout": tone-colored border/background + md-lite body. */
export function CalloutCard({ payload }: { payload: Payload }) {
    const tone = str(payload, "tone") || "info";
    return (
        <div
            className={`h-full w-full overflow-auto rounded-md border-l-4 p-2 ${CALLOUT_TONE[tone] ?? CALLOUT_TONE.info}`}
        >
            {renderMdLite(str(payload, "md"))}
        </div>
    );
}

const STEP_STATUS_DOT: Record<string, string> = {
    pass: "bg-emerald-400",
    fail: "bg-[var(--dd-danger)]",
    todo: "bg-[var(--dd-text-muted)]",
};

/** kind "step": numbered journey step with a status chip, optional note. */
export function StepCard({ payload }: { payload: Payload }) {
    const n = num(payload, "n");
    const status = str(payload, "status") || "todo";
    const note = str(payload, "note");
    return (
        <div className="flex h-full w-full flex-col gap-1 overflow-auto p-2 text-sm">
            <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${STEP_STATUS_DOT[status] ?? STEP_STATUS_DOT.todo}`} />
                <span className="font-semibold text-[var(--dd-text-primary)]">
                    {n != null ? `${n}. ` : ""}
                    {str(payload, "title")}
                </span>
            </div>
            {note ? <p className="text-xs text-[var(--dd-text-muted)]">{note}</p> : null}
        </div>
    );
}

/** kind "checklist": read-only items with a done count header. */
export function ChecklistCard({ payload }: { payload: Payload }) {
    const items = Array.isArray(payload.items) ? (payload.items as Array<{ text?: string; done?: boolean }>) : [];
    const done = items.filter((it) => it.done).length;
    return (
        <div className="h-full w-full overflow-auto p-2 text-sm">
            <div className="mb-1 font-semibold text-[var(--dd-text-primary)]">
                {str(payload, "title") || "Checklist"} — {done}/{items.length}
            </div>
            <ul className="space-y-0.5">
                {items.map((it, i) => (
                    <li key={i} className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            checked={Boolean(it.done)}
                            readOnly
                            className="accent-[var(--dd-accent-from)]"
                        />
                        <span className={it.done ? "text-[var(--dd-text-muted)] line-through" : ""}>
                            {it.text ?? ""}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function VizTable({ data }: { data: Payload }) {
    const cols = Array.isArray(data.cols) ? (data.cols as string[]) : [];
    const rows = Array.isArray(data.rows) ? (data.rows as unknown[][]) : [];
    return (
        <table className="w-full text-left text-xs">
            <thead>
                <tr>
                    {cols.map((c, i) => (
                        <th key={i} className="border-b border-[var(--dd-border)] pb-1 font-semibold">
                            {c}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {rows.map((row, i) => (
                    <tr key={i}>
                        {row.map((cell, j) => (
                            <td key={j} className="py-0.5">
                                {String(cell)}
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function VizBars({ data }: { data: Payload }) {
    const items = Array.isArray(data.items) ? (data.items as Array<{ label: string; value: number }>) : [];
    const max = Math.max(1, ...items.map((it) => it.value));
    return (
        <div className="flex h-full flex-col justify-center gap-1.5">
            {items.map((it, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-16 shrink-0 truncate text-[var(--dd-text-secondary)]">{it.label}</span>
                    <div className="h-3 flex-1 rounded bg-[var(--dd-border)]">
                        <div
                            className="h-3 rounded bg-[var(--dd-accent-from)]"
                            style={{ width: `${(it.value / max) * 100}%` }}
                        />
                    </div>
                    <span className="w-8 shrink-0 text-right">{it.value}</span>
                </div>
            ))}
        </div>
    );
}

function VizTimeline({ data }: { data: Payload }) {
    const items = Array.isArray(data.items) ? (data.items as Array<{ label: string; when: string }>) : [];
    return (
        <ul className="space-y-1 text-xs">
            {items.map((it, i) => (
                <li key={i} className="flex justify-between gap-2">
                    <span>{it.label}</span>
                    <span className="text-[var(--dd-text-muted)]">{it.when}</span>
                </li>
            ))}
        </ul>
    );
}

function VizMatrix({ data }: { data: Payload }) {
    const points = Array.isArray(data.points) ? (data.points as Array<{ label: string; x: number; y: number }>) : [];
    return (
        <div className="relative h-full w-full rounded border border-[var(--dd-border)]">
            {points.map((p, i) => (
                <span
                    key={i}
                    title={p.label}
                    className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--dd-accent-from)]"
                    style={{ left: `${p.x * 100}%`, top: `${(1 - p.y) * 100}%` }}
                />
            ))}
        </div>
    );
}

function VizFlow({ data }: { data: Payload }) {
    const steps = Array.isArray(data.steps) ? (data.steps as string[]) : [];
    return (
        <div className="flex h-full items-center gap-1 overflow-auto text-xs">
            {steps.map((s, i) => (
                <span key={i} className="flex items-center gap-1 whitespace-nowrap">
                    <span className="rounded-full bg-[var(--dd-border)] px-2 py-0.5">{s}</span>
                    {i < steps.length - 1 ? <span className="text-[var(--dd-text-muted)]">→</span> : null}
                </span>
            ))}
        </div>
    );
}

function VizLine({ data }: { data: Payload }) {
    const series = Array.isArray(data.series) ? (data.series as Array<{ label: string; points: number[] }>) : [];
    const all = series.flatMap((s) => s.points);
    const min = Math.min(0, ...all);
    const max = Math.max(1, ...all);
    return (
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full">
            {series.map((s, i) => {
                const pts = s.points
                    .map((v, j) => {
                        const x = (j / Math.max(1, s.points.length - 1)) * 100;
                        const y = 40 - ((v - min) / (max - min || 1)) * 40;
                        return `${x},${y}`;
                    })
                    .join(" ");
                return (
                    <polyline
                        key={i}
                        points={pts}
                        fill="none"
                        stroke={i === 0 ? "var(--dd-accent-from)" : "var(--dd-text-muted)"}
                        strokeWidth={1.5}
                    />
                );
            })}
        </svg>
    );
}

function VizStat({ data }: { data: Payload }) {
    const items = Array.isArray(data.items)
        ? (data.items as Array<{ label: string; value: string | number; delta?: string; unit?: string }>)
        : [];
    return (
        <div className="grid h-full grid-cols-1 gap-2 overflow-auto">
            {items.map((it, i) => (
                <div key={i}>
                    <div className="text-lg font-bold text-[var(--dd-text-primary)]">
                        {it.value}
                        {it.unit ? <span className="text-xs font-normal"> {it.unit}</span> : null}
                    </div>
                    <div className="text-xs text-[var(--dd-text-muted)]">
                        {it.label}
                        {it.delta ? <span className="ml-1">{it.delta}</span> : null}
                    </div>
                </div>
            ))}
        </div>
    );
}

/** kind "viz": dispatch on payload.viz — data-only visualizations, no charting dependency. */
export function VizCard({ payload }: { payload: Payload }) {
    const viz = str(payload, "viz") || "table";
    const data = (typeof payload.data === "object" && payload.data !== null ? payload.data : {}) as Payload;
    const title = str(payload, "title");
    return (
        <div className="flex h-full w-full flex-col gap-1 overflow-hidden p-2">
            {title ? (
                <div className="shrink-0 text-xs font-semibold text-[var(--dd-text-secondary)]">{title}</div>
            ) : null}
            <div className="min-h-0 flex-1">
                {viz === "matrix" ? (
                    <VizMatrix data={data} />
                ) : viz === "flow" ? (
                    <VizFlow data={data} />
                ) : viz === "bars" ? (
                    <VizBars data={data} />
                ) : viz === "timeline" ? (
                    <VizTimeline data={data} />
                ) : viz === "line" ? (
                    <VizLine data={data} />
                ) : viz === "stat" ? (
                    <VizStat data={data} />
                ) : (
                    <VizTable data={data} />
                )}
            </div>
        </div>
    );
}

/** kind "cluster": translucent frame + title. Renders under member cards — the frame itself is
 *  pointer-events:none (clicks pass through to cards on top); only the title strip is
 *  draggable/selectable. */
export function ClusterFrame({
    payload,
    onTitlePointerDown,
    onPointerMove,
    onPointerUp,
}: {
    payload: Payload;
    onTitlePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
    return (
        <div className="pointer-events-none h-full w-full rounded-lg border-2 border-dashed border-[var(--dd-border)] bg-[var(--dd-bg-panel)]/40">
            <div
                onPointerDown={onTitlePointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className="pointer-events-auto w-fit rounded-br-lg rounded-tl-lg bg-[var(--dd-bg-panel)] px-2 py-1 text-xs font-semibold text-[var(--dd-text-secondary)]"
            >
                {str(payload, "title") || "Cluster"}
            </div>
        </div>
    );
}

const DEVICE_FRAME: Record<string, string> = {
    phone: "rounded-2xl border-4",
    tablet: "rounded-xl border-4",
    web: "rounded-md border-2",
};

const NODE_LABEL: Record<string, (n: Payload) => string> = {
    nav: (n) => str(n, "label") || "‹ back",
    tabbar: (n) => str(n, "label") || "tab · tab · tab",
    heading: (n) => str(n, "label") || "Heading",
    text: (n) => str(n, "label"),
    button: (n) => str(n, "label") || "Button",
    input: (n) => str(n, "label") || "input",
    listitem: (n) => str(n, "label") || "",
    modal: (n) => str(n, "label") || "Modal",
    chiprow: (n) => str(n, "label") || "",
};

function WireframeNode({ node }: { node: Payload }) {
    const t = str(node, "t");
    if (t === "divider") {
        return <div className="my-1 h-px bg-[var(--dd-border)]" />;
    }

    if (t === "img") {
        const h = str(node, "h") || "m";
        const height = h === "s" ? "h-8" : h === "l" ? "h-24" : "h-14";
        return (
            <div
                className={`flex ${height} items-center justify-center rounded bg-[var(--dd-border)] text-[9px] text-[var(--dd-text-muted)]`}
            >
                ⤫
            </div>
        );
    }

    if (t === "list") {
        const n = num(node, "n") ?? 3;
        return (
            <div className="space-y-1">
                {Array.from({ length: n }).map((_, i) => (
                    <div key={i} className="h-3 rounded bg-[var(--dd-border)]" />
                ))}
            </div>
        );
    }

    if (t === "button") {
        return (
            <div
                className={`rounded px-2 py-1 text-center text-[10px] ${
                    node.primary ? "bg-[var(--dd-accent-from)] text-black" : "border border-[var(--dd-border)]"
                }`}
            >
                {NODE_LABEL.button(node)}
            </div>
        );
    }

    if (t === "input") {
        return (
            <div className="rounded border border-[var(--dd-border)] px-2 py-1 text-[10px] text-[var(--dd-text-muted)]">
                {NODE_LABEL.input(node)}
            </div>
        );
    }

    if (t === "heading") {
        return <div className="text-xs font-semibold">{NODE_LABEL.heading(node)}</div>;
    }

    const label = NODE_LABEL[t]?.(node);
    return label ? (
        <div className="text-[10px] text-[var(--dd-text-muted)]">{label}</div>
    ) : (
        <div className="rounded border border-dashed border-[var(--dd-border)] px-2 py-1 text-center text-[9px] text-[var(--dd-text-muted)]">
            {t || "?"}
        </div>
    );
}

/** kind "wireframe": lo-fi UI sketch — nodes render top-to-bottom inside a device-shaped frame. */
export function WireframeCard({ payload }: { payload: Payload }) {
    const device = str(payload, "device") || "phone";
    const nodes = Array.isArray(payload.nodes) ? (payload.nodes as Payload[]) : [];
    return (
        <div className="flex h-full w-full flex-col overflow-hidden">
            {str(payload, "title") ? (
                <div className="mb-1 shrink-0 text-xs font-semibold text-[var(--dd-text-secondary)]">
                    {str(payload, "title")}
                </div>
            ) : null}
            <div
                className={`flex-1 space-y-1.5 overflow-auto border-[var(--dd-border)] bg-[var(--dd-bg-panel)] p-2 ${
                    DEVICE_FRAME[device] ?? DEVICE_FRAME.phone
                }`}
            >
                {nodes.map((n, i) => (
                    <WireframeNode key={i} node={n} />
                ))}
            </div>
        </div>
    );
}

/** kind "shape": plain rounded rect with an optional label. */
export function ShapeCard({ payload }: { payload: Payload }) {
    const shape = str(payload, "shape") || "rect";
    const color = str(payload, "color") || "var(--dd-accent-from)";
    return (
        <div
            className={`flex h-full w-full items-center justify-center border-2 text-xs ${
                shape === "ellipse" ? "rounded-full" : "rounded-md"
            }`}
            style={{ borderColor: color }}
        >
            {str(payload, "label")}
        </div>
    );
}

/** kind "compare": a lightweight reference card — the actual pixel diff lives in CompareDeck;
 *  this is just a label pointing at the two cards it compares. */
export function CompareRefCard({ payload }: { payload: Payload }) {
    const a = (payload.a ?? {}) as Payload;
    const b = (payload.b ?? {}) as Payload;
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-md border border-[var(--dd-border)] text-xs text-[var(--dd-text-secondary)]">
            <span>compare</span>
            <span className="font-mono">
                card {String(a.cardId ?? "?")} ↔ card {String(b.cardId ?? "?")}
            </span>
        </div>
    );
}
