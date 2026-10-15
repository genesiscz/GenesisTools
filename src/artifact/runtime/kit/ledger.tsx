import { type ReactNode, useState } from "react";
import { Badge, type ChipItem, Chips, TONE_DOT, TONE_TEXT, type Tone } from "./primitives";

/**
 * A history of sync runs. Each entry shows counts while closed and the exact
 * field changes when open: added, removed, and changed with the old and the
 * new value. `diffFields` builds the changes from two flat records.
 */

export type LedgerValue = string | number | boolean | null;

export type FieldChange =
    | { field: string; kind: "added"; to: LedgerValue }
    | { field: string; kind: "removed"; from: LedgerValue }
    | { field: string; kind: "changed"; from: LedgerValue; to: LedgerValue };

export interface DiffFieldsOptions {
    /** Keys to leave out (timestamps, ids). */
    ignore?: string[];
    /** Display names per key. */
    labels?: Record<string, string>;
}

/** Field-level diff of two flat records. Keys keep first-seen order. Equal values produce nothing. Inputs are not changed. */
export function diffFields(
    before: Record<string, LedgerValue>,
    after: Record<string, LedgerValue>,
    options: DiffFieldsOptions = {}
): FieldChange[] {
    const ignore = new Set(options.ignore ?? []);
    const keys = [...Object.keys(before), ...Object.keys(after).filter((k) => !Object.hasOwn(before, k))];
    const changes: FieldChange[] = [];

    for (const key of keys) {
        if (ignore.has(key)) {
            continue;
        }

        const field = options.labels?.[key] ?? key;
        const inBefore = Object.hasOwn(before, key);
        const inAfter = Object.hasOwn(after, key);

        if (inBefore && !inAfter) {
            changes.push({ field, kind: "removed", from: before[key] });
        } else if (!inBefore && inAfter) {
            changes.push({ field, kind: "added", to: after[key] });
        } else if (before[key] !== after[key]) {
            changes.push({ field, kind: "changed", from: before[key], to: after[key] });
        }
    }

    return changes;
}

export type LedgerFormat = (field: string, value: LedgerValue) => string;

/** Default value text: "empty" for null, yes or no for booleans. */
export function formatLedgerValue(_field: string, value: LedgerValue): string {
    if (value === null) {
        return "empty";
    }

    if (typeof value === "boolean") {
        return value ? "yes" : "no";
    }

    return String(value);
}

const MAX_VALUE_CHARS = 80;

function Value({ text, className }: { text: string; className?: string }) {
    const cut = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;

    return (
        <span className={`rounded px-1 break-words ${className ?? ""}`} title={cut === text ? undefined : text}>
            {cut}
        </span>
    );
}

/** The sentence a screen reader hears for one change. */
export function fieldChangeSentence(change: FieldChange, format: LedgerFormat = formatLedgerValue): string {
    if (change.kind === "added") {
        return `${change.field} added: ${format(change.field, change.to)}`;
    }

    if (change.kind === "removed") {
        return `${change.field} removed: ${format(change.field, change.from)}`;
    }

    return `${change.field} changed from ${format(change.field, change.from)} to ${format(change.field, change.to)}`;
}

export interface FieldDiffProps {
    changes: FieldChange[];
    /** Format a value for display, for example a date. */
    formatValue?: LedgerFormat;
}

/** One row per field change: the field name, then the added, removed or old and new value. */
export function FieldDiff({ changes, formatValue = formatLedgerValue }: FieldDiffProps) {
    return (
        <ul className="flex flex-col gap-1 text-sm">
            {changes.map((change, i) => (
                <li
                    key={`${change.field}-${i}`}
                    data-change={change.kind}
                    className="grid grid-cols-[minmax(6rem,12rem)_1fr] items-baseline gap-3"
                >
                    <span className="truncate font-mono text-xs text-dim" title={change.field}>
                        {change.field}
                    </span>
                    <span className="min-w-0">
                        <span aria-hidden="true">
                            {change.kind === "added" ? (
                                <span className="text-ok">
                                    + <Value text={formatValue(change.field, change.to)} className="bg-ok/10" />
                                </span>
                            ) : change.kind === "removed" ? (
                                <span className="text-err">
                                    −{" "}
                                    <Value
                                        text={formatValue(change.field, change.from)}
                                        className="bg-err/10 line-through"
                                    />
                                </span>
                            ) : (
                                <>
                                    <Value
                                        text={formatValue(change.field, change.from)}
                                        className="text-dim line-through"
                                    />
                                    <span className="mx-1.5 text-dim">→</span>
                                    <Value text={formatValue(change.field, change.to)} className="text-ink" />
                                </>
                            )}
                        </span>
                        <span className="sr-only">{fieldChangeSentence(change, formatValue)}</span>
                    </span>
                </li>
            ))}
        </ul>
    );
}

export interface LedgerItem {
    id: string;
    label: string;
    href?: string;
    changes: FieldChange[];
}

export interface LedgerEntry {
    id: string;
    /** ISO timestamp or a display string. */
    time: string;
    title: string;
    tone?: Tone;
    meta?: ChipItem[];
    /** One block per changed item (a task, an issue). */
    items?: LedgerItem[];
    /** Or one flat list of changes. */
    changes?: FieldChange[];
    open?: boolean;
}

export interface ChangeLedgerProps {
    entries: LedgerEntry[];
    /** Entries with more changes than this show the first ones and a "Show all N" button. Default 20. */
    maxChanges?: number;
    formatValue?: LedgerFormat;
    emptyText?: string;
}

/** Added, removed and changed counts over an entry's items and flat changes. */
export function ledgerCounts(entry: Pick<LedgerEntry, "items" | "changes">): Record<FieldChange["kind"], number> {
    const counts = { added: 0, removed: 0, changed: 0 };

    for (const change of [...(entry.changes ?? []), ...(entry.items ?? []).flatMap((item) => item.changes)]) {
        counts[change.kind] += 1;
    }

    return counts;
}

function TimeStamp({ time }: { time: string }) {
    const parsed = Date.parse(time);

    if (Number.isNaN(parsed)) {
        return <span>{time}</span>;
    }

    return (
        <time dateTime={new Date(parsed).toISOString()}>
            {/^\d{4}-\d{2}-\d{2}T/.test(time)
                ? time.replace("T", " ").replace(/(:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, "$1")
                : time}
        </time>
    );
}

interface LedgerBlock {
    key: string;
    label?: ReactNode;
    changes: FieldChange[];
}

/** Spend a change budget across blocks in order; returns the blocks cut to fit. */
function cutToBudget(blocks: LedgerBlock[], budget: number): LedgerBlock[] {
    const out: LedgerBlock[] = [];
    let left = budget;

    for (const block of blocks) {
        if (left <= 0) {
            break;
        }

        out.push({ ...block, changes: block.changes.slice(0, left) });
        left -= block.changes.length;
    }

    return out;
}

/** Timeline of sync runs, each opening to its field changes. */
export function ChangeLedger({
    entries,
    maxChanges = 20,
    formatValue = formatLedgerValue,
    emptyText = "No changes recorded.",
}: ChangeLedgerProps) {
    // Open state is keyed by entry id, so a NEW entries array with the same ids keeps what was open.
    const [open, setOpen] = useState<Set<string>>(() => new Set(entries.filter((e) => e.open).map((e) => e.id)));
    const [showAll, setShowAll] = useState<Set<string>>(() => new Set());

    if (entries.length === 0) {
        return <div className="my-3 text-sm text-dim">{emptyText}</div>;
    }

    const toggle = (id: string, next: boolean): void => {
        setOpen((prev) => {
            if (prev.has(id) === next) {
                return prev;
            }

            const copy = new Set(prev);

            if (next) {
                copy.add(id);
            } else {
                copy.delete(id);
            }

            return copy;
        });
    };

    const smallButton =
        "rounded border border-line px-2 py-0.5 text-xs text-dim hover:border-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info";

    return (
        <div className="my-3">
            <div className="mb-2 flex gap-2">
                <button
                    type="button"
                    className={smallButton}
                    onClick={() => setOpen(new Set(entries.map((e) => e.id)))}
                >
                    Expand all
                </button>
                <button type="button" className={smallButton} onClick={() => setOpen(new Set())}>
                    Collapse all
                </button>
            </div>
            <ol className="relative ml-2 border-l border-line pl-6">
                {entries.map((entry) => {
                    const counts = ledgerCounts(entry);
                    const total = counts.added + counts.removed + counts.changed;
                    const blocks: LedgerBlock[] = [
                        ...(entry.changes?.length ? [{ key: "_flat", changes: entry.changes }] : []),
                        ...(entry.items ?? []).map((item) => ({
                            key: item.id,
                            label: item.href ? (
                                <a href={item.href} className="text-accent hover:underline">
                                    {item.label}
                                </a>
                            ) : (
                                item.label
                            ),
                            changes: item.changes,
                        })),
                    ];
                    const full = showAll.has(entry.id) || total <= maxChanges;
                    const shown = full ? blocks : cutToBudget(blocks, maxChanges);
                    const isOpen = open.has(entry.id);

                    return (
                        <li key={entry.id} className="relative mb-4 last:mb-0" data-ledger-entry={entry.id}>
                            <span
                                aria-hidden="true"
                                className={`absolute -left-[1.85rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-canvas ${TONE_DOT[entry.tone ?? "neutral"]}`}
                            />
                            <details
                                open={isOpen}
                                onToggle={(event) => toggle(entry.id, event.currentTarget.open)}
                                className="group"
                            >
                                <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded px-1 py-0.5 hover:bg-panel/60 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info [&::-webkit-details-marker]:hidden">
                                    <span
                                        aria-hidden="true"
                                        className="text-dim transition-transform group-open:rotate-90"
                                    >
                                        ▸
                                    </span>
                                    <span className="font-mono text-xs text-dim">
                                        <TimeStamp time={entry.time} />
                                    </span>
                                    <span
                                        className={`font-medium ${entry.tone && entry.tone !== "neutral" ? TONE_TEXT[entry.tone] : "text-ink"}`}
                                    >
                                        {entry.title}
                                    </span>
                                    <span className="inline-flex gap-1.5" data-ledger-counts="">
                                        {counts.added ? <Badge tone="ok" pill>{`+${counts.added} added`}</Badge> : null}
                                        {counts.removed ? (
                                            <Badge tone="err" pill>{`−${counts.removed} removed`}</Badge>
                                        ) : null}
                                        {counts.changed ? (
                                            <Badge tone="warn" pill>{`${counts.changed} changed`}</Badge>
                                        ) : null}
                                        {total === 0 ? <span className="text-xs text-dim">no changes</span> : null}
                                    </span>
                                </summary>
                                <div className="mt-2 flex flex-col gap-3 pl-5">
                                    {entry.meta?.length ? <Chips items={entry.meta} /> : null}
                                    {shown.map((block) => (
                                        <div key={block.key}>
                                            {block.label ? (
                                                <div className="mb-1 text-sm font-medium text-ink">{block.label}</div>
                                            ) : null}
                                            <FieldDiff changes={block.changes} formatValue={formatValue} />
                                        </div>
                                    ))}
                                    {full ? null : (
                                        <button
                                            type="button"
                                            className={`${smallButton} self-start`}
                                            onClick={() => setShowAll((prev) => new Set(prev).add(entry.id))}
                                        >
                                            {`Show all ${total}`}
                                        </button>
                                    )}
                                </div>
                            </details>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
