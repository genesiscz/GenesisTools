import { type CSSProperties, type ReactNode, useRef } from "react";
import { usePageLook } from "./look";
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
    /** In the ascii variant a line break continues the label on the next row, under the same guides. */
    label: string;
    children?: TreeNode[];
    tone?: Tone;
    /** Label colour (any CSS colour) for this node and, unless they set their own, its descendants. Wins over `tone`. */
    color?: string;
    badge?: string;
    /** Right-aligned monospace detail (a size, a count, a line range). In the ascii variant: the comment column; a line break continues it. */
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
    /** "collapsible" (default): details rows. "ascii": a static command-tree listing with ├─ │ └─ guides and aligned columns. */
    variant?: "collapsible" | "ascii";
    /** Ascii variant: colour of the badge column (default the accent). */
    badgeColor?: string;
    className?: string;
}

/** One printed row of the ascii tree. Column positions are in characters. */
export interface AsciiTreeRow {
    /** Guide characters before the label ("│  ├─ "). */
    guide: string;
    label: string;
    /** Inherited label colour. */
    color?: string;
    tone?: Tone;
    /** A top-level node's row: bold ink. */
    root: boolean;
    badge?: string;
    meta?: string;
    /** Column where the badge starts (siblings share it). */
    badgeAt: number;
    /** Column where the comment starts. */
    metaAt: number;
    /** An empty spacer row between top-level nodes. */
    blank?: boolean;
}

interface DraftRow {
    guide: string;
    label: string;
    color?: string;
    tone?: Tone;
    root: boolean;
    badge?: string;
    meta?: string;
    group: number;
    /** Index of the row that starts this node, for a continued comment. */
    lead: number;
    blank?: boolean;
}

/**
 * Lay out the ascii tree. Badges line up per sibling group, two columns after
 * the longest label in the group that carries a badge or a comment. Comments
 * line up in one column across the nested rows; a top-level row's comment
 * starts at that column or after its own badge, whichever is later, and a
 * continued comment stays under its first line.
 */
export function asciiTreeRows(nodes: TreeNode[]): AsciiTreeRow[] {
    const drafts: DraftRow[] = [];
    let groups = 0;

    const pushNode = (node: TreeNode, first: string, rest: string, root: boolean, group: number, color?: string) => {
        const labels = node.label.split("\n");
        const metas = node.meta ? node.meta.split("\n") : [];
        const lead = drafts.length;
        const own = node.color ?? color;

        for (let k = 0; k < Math.max(labels.length, metas.length); k += 1) {
            drafts.push({
                guide: k === 0 ? first : rest,
                label: labels[k] ?? "",
                color: own,
                tone: node.tone,
                root,
                badge: k === 0 ? node.badge : undefined,
                meta: metas[k],
                group,
                lead,
            });
        }

        return own;
    };

    const walk = (children: TreeNode[], prefix: string, color: string | undefined) => {
        const group = groups++;

        children.forEach((child, i) => {
            const last = i === children.length - 1;
            const cont = prefix + (last ? "   " : "│  ");
            const own = pushNode(child, `${prefix}${last ? "└─ " : "├─ "}`, cont, false, group, color);

            if (child.children?.length) {
                walk(child.children, cont, own);
            }
        });
    };

    const rootGroup = groups++;

    nodes.forEach((node, i) => {
        if (i > 0) {
            drafts.push({ guide: "", label: "", root: true, group: rootGroup, lead: drafts.length, blank: true });
        }

        const own = pushNode(node, "", "", true, rootGroup, undefined);

        if (node.children?.length) {
            walk(node.children, "", own);
        }
    });

    const width = (row: DraftRow) => row.guide.length + row.label.length;
    const badgeAt = new Map<number, number>();

    drafts.forEach((row, i) => {
        if (!row.blank && (row.badge || row.meta) && i === row.lead) {
            badgeAt.set(row.group, Math.max(badgeAt.get(row.group) ?? 0, width(row) + 2));
        }
    });

    /** Where a row's comment would start on its own: after its badge, or two columns after its label. */
    const natural = (row: DraftRow): number =>
        row.badge ? (badgeAt.get(row.group) ?? width(row) + 2) + row.badge.length + 2 : width(row) + 2;
    const metaColumn = drafts.reduce(
        (max, row, i) => (row.meta && !row.root && i === row.lead ? Math.max(max, natural(row)) : max),
        0
    );
    const metaStart = new Map<number, number>();

    return drafts.map((row, i) => {
        let metaAt = 0;

        if (row.meta) {
            if (i === row.lead) {
                metaAt = Math.max(metaColumn, natural(row));
                metaStart.set(row.lead, metaAt);
            } else {
                metaAt = metaStart.get(row.lead) ?? Math.max(metaColumn, width(row) + 2);
            }
        }

        return {
            guide: row.guide,
            label: row.label,
            color: row.color,
            tone: row.tone,
            root: row.root,
            badge: row.badge,
            meta: row.meta,
            badgeAt: badgeAt.get(row.group) ?? width(row) + 2,
            metaAt,
            blank: row.blank,
        };
    });
}

function AsciiTree({ nodes, badgeColor, className }: { nodes: TreeNode[]; badgeColor: string; className?: string }) {
    const isDocument = usePageLook() === "document";
    const rows = asciiTreeRows(nodes);

    return (
        <div
            className={`overflow-x-auto whitespace-pre font-mono text-ink-2 ${isDocument ? "py-1 text-[15px] leading-[1.75]" : "my-2 text-[13px] leading-[1.6]"} ${className ?? ""}`}
        >
            {rows.map((row, i) => {
                if (row.blank) {
                    return <div key={i}> </div>;
                }

                const labelEnd = row.guide.length + row.label.length;
                const badgeGap = row.badge ? Math.max(1, row.badgeAt - labelEnd) : 0;
                const textEnd = row.badge ? row.badgeAt + row.badge.length : labelEnd;
                const metaGap = row.meta ? Math.max(1, row.metaAt - textEnd) : 0;
                const labelColor = row.color ? { color: row.color } : undefined;

                return (
                    <div key={i}>
                        <span aria-hidden="true">{row.guide}</span>
                        <span
                            className={
                                row.root
                                    ? "font-bold text-ink"
                                    : `font-semibold ${row.color ? "" : row.tone ? TONE_TEXT[row.tone] : "text-ink"}`
                            }
                            style={row.root ? undefined : labelColor}
                        >
                            {row.label}
                        </span>
                        {row.badge ? (
                            <>
                                {" ".repeat(badgeGap)}
                                <span style={{ color: badgeColor }}>{row.badge}</span>
                            </>
                        ) : null}
                        {row.meta ? (
                            <>
                                {" ".repeat(metaGap)}
                                <span className="text-dim">{row.meta}</span>
                            </>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

function TreeLabel({ node, dir, color }: { node: TreeNode; dir: boolean; color?: string }) {
    return (
        <span className="flex min-w-0 flex-1 items-center gap-2">
            {node.tone ? <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[node.tone]}`} /> : null}
            <span
                className={`truncate ${dir ? "font-medium" : "font-mono text-[0.85rem]"} ${node.tone && !color ? TONE_TEXT[node.tone] : ""}`}
                style={color ? { color } : undefined}
            >
                {node.label}
                {dir ? <span className="text-dim">/</span> : null}
            </span>
            {node.badge ? <Badge tone={node.tone ?? "neutral"}>{node.badge}</Badge> : null}
            {node.meta ? <span className="ml-auto shrink-0 font-mono text-xs text-dim">{node.meta}</span> : null}
        </span>
    );
}

function TreeBranch({ node, depth, open, color }: { node: TreeNode; depth: number; open: number; color?: string }) {
    const dir = node.children !== undefined;
    const own = node.color ?? color;
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
                    <TreeLabel node={node} dir={false} color={own} />
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
                    <TreeLabel node={node} dir color={own} />
                </summary>
                {note}
                <ul className="ml-2 border-l border-line pl-2">
                    {node.children?.map((child, i) => (
                        <TreeBranch
                            key={`${child.label}-${i}`}
                            node={child}
                            depth={depth + 1}
                            open={open}
                            color={own}
                        />
                    ))}
                </ul>
            </details>
        </li>
    );
}

/** Collapsible tree: file trees (`treeFromPaths`), org charts, nested config. `variant="ascii"` prints a command tree. */
export function TreeView({
    nodes,
    open = 1,
    variant = "collapsible",
    badgeColor = "var(--accent)",
    className,
}: TreeViewProps) {
    if (variant === "ascii") {
        return <AsciiTree nodes={nodes} badgeColor={badgeColor} className={className} />;
    }

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

/** The marker glyph per step status, shared by Steps and Wizard. */
export const STEP_GLYPH: Record<StepStatus, string> = {
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
    /** Column header. Optional with `plain` (a bare two-column layout). */
    title?: string;
    /** With `plain`: a small mono line after the title ("scattered"). */
    hint?: string;
    tone?: Tone;
    badge?: string;
    body: BodyContent;
}

export interface CompareProps {
    items: CompareItem[];
    /** Columns on wide screens (default: one per item, at most 3); always one column on narrow screens. */
    columns?: number;
    /** Open columns with a large title and no box, for a before/after whose columns hold their own cards. A column grows to fit wide content (a code tree). */
    plain?: boolean;
    /** With `plain`: relative column widths on wide screens (`[1.05, 1]`). Default equal. */
    weights?: number[];
}

/** Before/after, option A vs B vs C: equal columns with a titled header each. */
export function Compare({ items, columns, plain = false, weights }: CompareProps) {
    const cols = columns ?? Math.min(items.length, 3);

    if (plain) {
        const tracks = weights?.length ? weights.map((w) => `${w}fr`).join(" ") : `repeat(${cols}, 1fr)`;

        return (
            <div
                className="grid items-start gap-[22px] min-[1020px]:grid-cols-[var(--tracks)]"
                style={{ "--tracks": tracks } as CSSProperties}
            >
                {items.map((item, i) => (
                    <section key={`${item.title ?? "column"}-${i}`}>
                        {item.title ? (
                            <header className="mb-3 flex items-baseline gap-3">
                                <h3
                                    className={`font-display text-[22px] font-bold leading-[normal] ${item.tone ? TONE_TEXT[item.tone] : "text-ink"}`}
                                >
                                    {item.title}
                                </h3>
                                {item.hint ? (
                                    <span className="font-mono text-sm font-medium leading-[normal] text-dim">
                                        {item.hint}
                                    </span>
                                ) : null}
                                {item.badge ? <Badge tone={item.tone ?? "neutral"}>{item.badge}</Badge> : null}
                            </header>
                        ) : null}
                        <div>{renderBody(item.body)}</div>
                    </section>
                ))}
            </div>
        );
    }

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

// ─── MappingList ───

export interface MappingItem {
    /** The old name, flag or path. */
    from: string;
    /** What replaces it. */
    to: string;
    /** "stacked" layout: the row label in the left column ("Window"). */
    label?: string;
    /** A line under the row (inline markdown): what happens to the old one. */
    note?: string;
}

export interface MappingListProps {
    items: MappingItem[];
    /** "arrow" (default): `from → to` on one row, the note under it. "stacked": a label column, the old value struck through above the new one. */
    layout?: "arrow" | "stacked";
    /** Colour of the arrow, or of the labels in the stacked layout (any CSS colour). Default the accent. */
    color?: string;
}

/** Old name to new name, one boxed row each: aliases after a move, a flag grammar that replaces several. */
export function MappingList({ items, layout = "arrow", color = "var(--accent)" }: MappingListProps) {
    if (layout === "stacked") {
        return (
            <ul>
                {items.map((item, i) => (
                    <li
                        key={`${item.label ?? item.from}-${i}`}
                        className="mb-2.5 grid grid-cols-[120px_1fr] gap-x-3.5 gap-y-1.5 rounded-card border border-line bg-panel px-3.5 py-3 transition-[translate,border-color] duration-200 hover:translate-x-0.5 hover:border-[var(--map-color)]"
                        style={{ "--map-color": color } as CSSProperties}
                    >
                        <span className="font-display text-[15px] font-bold leading-[normal]" style={{ color }}>
                            {item.label}
                        </span>
                        <span className="font-mono text-sm leading-[1.6] text-dim line-through decoration-[color-mix(in_srgb,var(--err)_60%,transparent)]">
                            <span className="sr-only">was </span>
                            {item.from}
                        </span>
                        <span className="col-start-2 font-mono text-[14.5px] leading-[1.6] text-ink">
                            <span className="sr-only">now </span>
                            {item.to}
                        </span>
                        {item.note ? (
                            <span className="col-start-2 text-sm text-dim">
                                <MdInline>{item.note}</MdInline>
                            </span>
                        ) : null}
                    </li>
                ))}
            </ul>
        );
    }

    return (
        <ul className="mt-4 grid gap-2">
            {items.map((item, i) => (
                <li
                    key={`${item.from}-${i}`}
                    className="grid grid-cols-1 items-center gap-2.5 rounded-[10px] border border-line bg-panel-2 px-3 py-[9px] font-mono text-[14.5px] leading-[normal] sm:grid-cols-[minmax(200px,1fr)_auto_minmax(220px,1.3fr)]"
                >
                    <span className="text-ink-2">{item.from}</span>
                    <span className="hidden sm:inline" style={{ color }} aria-hidden="true">
                        →
                    </span>
                    <span className="text-ink">
                        <span className="sr-only">becomes </span>
                        {item.to}
                    </span>
                    {item.note ? (
                        <span className="col-span-full -mt-0.5 font-sans text-sm leading-[normal] text-dim">
                            <MdInline>{item.note}</MdInline>
                        </span>
                    ) : null}
                </li>
            ))}
        </ul>
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
    /** Objects from the root down to this node; a back-reference renders as a marker instead of recursing forever. */
    ancestors: readonly object[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function countLabel(count: number, list: boolean): string {
    const noun = list ? "item" : "key";

    return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function JsonNode({ name, value, depth, open, maxString, ancestors }: JsonNodeProps) {
    const label = name !== undefined ? <span className="hljs-attr">{name}</span> : null;
    const sep = name !== undefined ? <span className="text-dim">: </span> : null;

    if (isRecord(value) && !(value instanceof Date)) {
        // React's work loop is iterative, so a cycle does not overflow the stack: it renders
        // fibers until memory runs out and the page never paints.
        if (ancestors.includes(value)) {
            return (
                <div className="py-px">
                    <span className="inline-block w-4" />
                    {label}
                    {sep}
                    <span className="text-dim">[circular]</span>
                </div>
            );
        }

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

        const next = [...ancestors, value];

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
                            ancestors={next}
                        />
                    ))}
                </div>
            </details>
        );
    }

    let rendered: ReactNode;

    if (value instanceof Date) {
        // An object with no enumerable keys, so the record branch would have shown `{}`.
        const iso = Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
        rendered = <span className="hljs-string">"{iso}"</span>;
    } else if (typeof value === "string") {
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
            <JsonNode name={name} value={value} depth={0} open={open} maxString={maxString} ancestors={[]} />
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
