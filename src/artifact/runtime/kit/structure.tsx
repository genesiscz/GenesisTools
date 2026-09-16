import { type CSSProperties, type ReactNode, useRef } from "react";
import { MdInline } from "./md";
import { Badge, type BodyContent, renderBody, TONE_BORDER, TONE_DOT, TONE_TEXT, type Tone } from "./primitives";

/**
 * Structure views, no dependencies: a collapsible tree (file trees,
 * hierarchies), a status stepper (pipelines, request flows), side-by-side
 * comparison, key/value grids, a JSON explorer and a captioned figure with a
 * zoom dialog. Command transcripts are `CodeBlock lang="console"`.
 */

const CHEVRON = "inline-block w-4 shrink-0 select-none text-center text-dim transition-transform group-open:rotate-90";
const SUMMARY = "flex cursor-pointer list-none items-center gap-1.5 py-0.5 [&::-webkit-details-marker]:hidden";

// ─── TreeView ───

export interface TreeNode {
    label: string;
    children?: TreeNode[];
    tone?: Tone;
    badge?: string;
    /** Right-aligned monospace detail (a size, a count, a line range). */
    meta?: string;
    /** Inline markdown under the label. */
    note?: string;
}

/** A path with optional leaf decoration; a trailing slash marks a directory. */
export type TreePath = string | ({ path: string } & Omit<TreeNode, "label" | "children">);

function sortTree(nodes: TreeNode[]): TreeNode[] {
    for (const node of nodes) {
        if (node.children) {
            sortTree(node.children);
        }
    }

    return nodes.sort(
        (a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.label.localeCompare(b.label)
    );
}

/** Build a tree from slash-separated paths (`src/a/b.ts`). Directories sort first, then alphabetical. */
export function treeFromPaths(paths: TreePath[]): TreeNode[] {
    const root: TreeNode[] = [];

    for (const entry of paths) {
        const { path, ...leaf } = typeof entry === "string" ? { path: entry } : entry;
        const parts = path.split("/").filter(Boolean);
        const isDir = path.endsWith("/");
        let level = root;

        parts.forEach((part, index) => {
            const last = index === parts.length - 1;
            let node = level.find((n) => n.label === part);

            if (!node) {
                node = { label: part };
                level.push(node);
            }

            if (last) {
                Object.assign(node, leaf);
            }

            if (!last || isDir) {
                node.children ??= [];
                level = node.children;
            }
        });
    }

    return sortTree(root);
}

export interface TreeViewProps {
    nodes: TreeNode[];
    /** Levels expanded on load (default 1: the top level open, everything under it closed). */
    open?: number;
    className?: string;
}

function TreeLabel({ node, dir }: { node: TreeNode; dir: boolean }) {
    return (
        <span className="flex min-w-0 flex-1 items-center gap-2">
            {node.tone ? <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[node.tone]}`} /> : null}
            <span
                className={`truncate ${dir ? "font-medium" : "font-mono text-[0.85rem]"} ${node.tone ? TONE_TEXT[node.tone] : ""}`}
            >
                {node.label}
                {dir ? <span className="text-dim">/</span> : null}
            </span>
            {node.badge ? <Badge tone={node.tone ?? "neutral"}>{node.badge}</Badge> : null}
            {node.meta ? <span className="ml-auto shrink-0 font-mono text-xs text-dim">{node.meta}</span> : null}
        </span>
    );
}

function TreeBranch({ node, depth, open }: { node: TreeNode; depth: number; open: number }) {
    const dir = node.children !== undefined;
    const note = node.note ? (
        <div className="pl-6 text-xs text-dim">
            <MdInline>{node.note}</MdInline>
        </div>
    ) : null;

    if (!dir) {
        return (
            <li>
                <div className="flex items-center gap-1.5 py-0.5">
                    <span className="inline-block w-4 shrink-0" />
                    <TreeLabel node={node} dir={false} />
                </div>
                {note}
            </li>
        );
    }

    return (
        <li>
            <details open={depth < open} className="group">
                <summary className={SUMMARY}>
                    <span aria-hidden="true" className={CHEVRON}>
                        ▸
                    </span>
                    <TreeLabel node={node} dir />
                </summary>
                {note}
                <ul className="ml-2 border-l border-line pl-2">
                    {node.children?.map((child, i) => (
                        <TreeBranch key={`${child.label}-${i}`} node={child} depth={depth + 1} open={open} />
                    ))}
                </ul>
            </details>
        </li>
    );
}

/** Collapsible tree: file trees (`treeFromPaths`), org charts, nested config. */
export function TreeView({ nodes, open = 1, className }: TreeViewProps) {
    return (
        <ul className={`my-2 text-sm ${className ?? ""}`}>
            {nodes.map((node, i) => (
                <TreeBranch key={`${node.label}-${i}`} node={node} depth={0} open={open} />
            ))}
        </ul>
    );
}

// ─── Steps ───

export type StepStatus = "done" | "active" | "pending" | "failed" | "skipped";

export interface StepItem {
    label: string;
    status?: StepStatus;
    /** Small monospace line under the label (a duration, an id). */
    meta?: string;
    body?: BodyContent;
}

export interface StepsProps {
    steps: StepItem[];
    /** `row` (default) runs left to right on wide screens and stacks on narrow ones; `column` always stacks. */
    direction?: "row" | "column";
}

export const STEP_TONE: Record<StepStatus, Tone> = {
    done: "ok",
    active: "info",
    pending: "neutral",
    failed: "err",
    skipped: "neutral",
};

const STEP_GLYPH: Record<StepStatus, string> = {
    done: "✓",
    active: "●",
    pending: "○",
    failed: "✕",
    skipped: "⊘",
};

const STEP_FILL: Record<StepStatus, string> = {
    done: "bg-ok/15",
    active: "bg-panel animate-pulse",
    pending: "bg-panel",
    failed: "bg-err/15",
    skipped: "bg-panel",
};

/** Pipeline / stage stepper with a status per step. */
export function Steps({ steps, direction = "row" }: StepsProps) {
    const row = direction === "row";

    return (
        <ol className={`my-3 flex flex-col gap-3 ${row ? "md:flex-row md:items-start" : ""}`}>
            {steps.map((step, i) => {
                const status = step.status ?? "pending";
                const tone = STEP_TONE[status];
                const muted = status === "pending" || status === "skipped";

                return (
                    <li
                        key={`${step.label}-${i}`}
                        className={`flex min-w-0 gap-3 ${row ? "md:flex-1 md:flex-col md:items-center md:text-center" : ""}`}
                    >
                        <div className={`flex items-center ${row ? "md:w-full" : ""}`}>
                            {row ? (
                                <span
                                    aria-hidden="true"
                                    className={`hidden h-px flex-1 md:block ${i === 0 ? "bg-transparent" : "bg-line"}`}
                                />
                            ) : null}
                            <span
                                aria-label={status}
                                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${TONE_BORDER[tone]} ${TONE_TEXT[tone]} ${STEP_FILL[status]}`}
                            >
                                {STEP_GLYPH[status]}
                            </span>
                            {row ? (
                                <span
                                    aria-hidden="true"
                                    className={`hidden h-px flex-1 md:block ${i === steps.length - 1 ? "bg-transparent" : "bg-line"}`}
                                />
                            ) : null}
                        </div>
                        <div className="min-w-0">
                            <div className={`text-sm font-medium ${muted ? "text-dim" : "text-ink"}`}>{step.label}</div>
                            {step.meta ? <div className="font-mono text-xs text-dim">{step.meta}</div> : null}
                            {step.body ? <div className="mt-1 text-sm text-dim">{renderBody(step.body)}</div> : null}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

// ─── Compare ───

export interface CompareItem {
    title: string;
    tone?: Tone;
    badge?: string;
    body: BodyContent;
}

export interface CompareProps {
    items: CompareItem[];
    /** Columns on wide screens (default: one per item, at most 3); always one column on narrow screens. */
    columns?: number;
}

/** Before/after, option A vs B vs C: equal columns with a titled header each. */
export function Compare({ items, columns }: CompareProps) {
    const cols = columns ?? Math.min(items.length, 3);

    return (
        <div
            className="my-3 grid gap-3 md:grid-cols-[repeat(var(--cols),minmax(0,1fr))]"
            style={{ "--cols": cols } as CSSProperties}
        >
            {items.map((item, i) => {
                const tone = item.tone ?? "neutral";

                return (
                    <section
                        key={`${item.title}-${i}`}
                        className={`rounded-card border ${TONE_BORDER[tone]} bg-panel/60 p-3`}
                    >
                        <header className="mb-2 flex items-center justify-between gap-2 border-b border-line pb-1.5">
                            <h4 className={`font-medium ${TONE_TEXT[tone]}`}>{item.title}</h4>
                            {item.badge ? <Badge tone={tone}>{item.badge}</Badge> : null}
                        </header>
                        <div className="text-sm">{renderBody(item.body)}</div>
                    </section>
                );
            })}
        </div>
    );
}

// ─── KeyValue ───

export interface KeyValueItem {
    key: string;
    /** A string renders as inline markdown. */
    value: string | ReactNode;
    tone?: Tone;
    mono?: boolean;
}

export interface KeyValueProps {
    items: KeyValueItem[];
    /** Item columns on wide screens (default 1). */
    columns?: 1 | 2 | 3;
    title?: string;
}

const KV_COLUMNS: Record<1 | 2 | 3, string> = { 1: "", 2: "md:grid-cols-2", 3: "md:grid-cols-3" };

/** Definition grid for configs, headers, identifiers: label left, value right. */
export function KeyValue({ items, columns = 1, title }: KeyValueProps) {
    return (
        <div className="my-3">
            {title ? <div className="mb-1 text-xs uppercase tracking-wide text-dim">{title}</div> : null}
            <dl className={`grid gap-x-6 ${KV_COLUMNS[columns]}`}>
                {items.map((item, i) => (
                    <div
                        key={`${item.key}-${i}`}
                        className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-3 border-b border-line/60 py-1 text-sm"
                    >
                        <dt className="text-dim">{item.key}</dt>
                        <dd
                            className={`min-w-0 break-words ${item.mono ? "font-mono text-[0.85rem]" : ""} ${item.tone ? TONE_TEXT[item.tone] : "text-ink"}`}
                        >
                            {typeof item.value === "string" ? <MdInline>{item.value}</MdInline> : item.value}
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

// ─── JsonView ───

export interface JsonViewProps {
    value: unknown;
    /** Root label. */
    name?: string;
    /** Levels expanded on load (default 2). */
    open?: number;
    /** Strings longer than this are cut with an ellipsis; the full text sits in the title (default 160). */
    maxString?: number;
    className?: string;
}

interface JsonNodeProps {
    name?: string;
    value: unknown;
    depth: number;
    open: number;
    maxString: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function countLabel(count: number, list: boolean): string {
    const noun = list ? "item" : "key";

    return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function JsonNode({ name, value, depth, open, maxString }: JsonNodeProps) {
    const label = name !== undefined ? <span className="hljs-attr">{name}</span> : null;
    const sep = name !== undefined ? <span className="text-dim">: </span> : null;

    if (isRecord(value)) {
        const list = Array.isArray(value);
        const entries = list ? value.map((v, i): [string, unknown] => [String(i), v]) : Object.entries(value);
        const [openBracket, closeBracket] = list ? ["[", "]"] : ["{", "}"];

        if (entries.length === 0) {
            return (
                <div className="py-px">
                    <span className="inline-block w-4" />
                    {label}
                    {sep}
                    <span className="text-dim">
                        {openBracket}
                        {closeBracket}
                    </span>
                </div>
            );
        }

        return (
            <details open={depth < open} className="group">
                <summary className={`${SUMMARY} py-px`}>
                    <span aria-hidden="true" className={CHEVRON}>
                        ▸
                    </span>
                    <span>
                        {label}
                        {sep}
                        <span className="text-dim">
                            {openBracket}
                            {countLabel(entries.length, list)}
                            {closeBracket}
                        </span>
                    </span>
                </summary>
                <div className="ml-2 border-l border-line pl-3">
                    {entries.map(([key, child]) => (
                        <JsonNode
                            key={key}
                            name={key}
                            value={child}
                            depth={depth + 1}
                            open={open}
                            maxString={maxString}
                        />
                    ))}
                </div>
            </details>
        );
    }

    let rendered: ReactNode;

    if (typeof value === "string") {
        const cut = value.length > maxString ? `${value.slice(0, maxString)}…` : value;
        rendered = (
            <span className="hljs-string" title={value.length > maxString ? value : undefined}>
                "{cut}"
            </span>
        );
    } else if (typeof value === "number" || typeof value === "bigint") {
        rendered = <span className="hljs-number">{String(value)}</span>;
    } else if (typeof value === "boolean") {
        rendered = <span className="hljs-literal">{String(value)}</span>;
    } else {
        rendered = <span className="hljs-literal text-dim">{value === null ? "null" : String(value)}</span>;
    }

    return (
        <div className="py-px">
            <span className="inline-block w-4" />
            {label}
            {sep}
            {rendered}
        </div>
    );
}

/** Collapsible JSON explorer for payloads, configs and API responses. */
export function JsonView({ value, name, open = 2, maxString = 160, className }: JsonViewProps) {
    return (
        <div
            className={`hljs my-3 overflow-x-auto rounded-card border border-line bg-canvas/80 p-3 font-mono text-[0.8rem] leading-relaxed ${className ?? ""}`}
        >
            <JsonNode name={name} value={value} depth={0} open={open} maxString={maxString} />
        </div>
    );
}

// ─── Figure ───

export interface FigureProps {
    src: string;
    alt: string;
    /** Inline markdown under the image. */
    caption?: string;
    /** Click opens the image at full size in a dialog (default on). */
    zoom?: boolean;
    /** Cap the rendered width (CSS length or px). */
    width?: number | string;
}

/** Image with a caption; click for a full-size dialog. */
export function Figure({ src, alt, caption, zoom = true, width }: FigureProps) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const open = (): void => {
        const dialog = dialogRef.current;

        if (dialog && typeof dialog.showModal === "function" && !dialog.open) {
            dialog.showModal();
        }
    };

    return (
        <figure className="my-3" style={{ maxWidth: width }}>
            {zoom ? (
                <button
                    type="button"
                    onClick={open}
                    aria-label={`open ${alt} at full size`}
                    className="block w-full cursor-zoom-in overflow-hidden rounded-card border border-line bg-panel"
                >
                    <img src={src} alt={alt} loading="lazy" className="block h-auto w-full" />
                </button>
            ) : (
                <img
                    src={src}
                    alt={alt}
                    loading="lazy"
                    className="block h-auto w-full rounded-card border border-line"
                />
            )}
            {caption ? (
                <figcaption className="mt-1.5 text-center text-xs text-dim">
                    <MdInline>{caption}</MdInline>
                </figcaption>
            ) : null}
            {zoom ? (
                <dialog
                    ref={dialogRef}
                    onClick={() => dialogRef.current?.close()}
                    className="m-auto max-h-[95dvh] max-w-[95vw] cursor-zoom-out rounded-card border border-line bg-canvas p-2 backdrop:bg-canvas/80"
                >
                    <img src={src} alt={alt} className="block max-h-[90dvh] w-auto max-w-full" />
                </dialog>
            ) : null}
        </figure>
    );
}
