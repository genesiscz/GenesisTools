import type { IndexedLogEntry } from "@app/debugging-master/types";
import { useMemo } from "react";
import { diffVars, findPreviousSnapshot, type SnapshotDelta } from "@/lib/diff";
import { useEntries } from "@/lib/entries-context";
import { formatDurationMs, formatTime } from "@/lib/format";
import { LEVEL_META } from "@/lib/levels";
import { computeTimerStats, type TimerStats } from "@/lib/timer-stats";
import { InlineJsonPreview } from "./InlineJsonPreview";

interface Props {
    entry: IndexedLogEntry;
}

export function ExpandedView({ entry }: Props): React.ReactElement {
    const refMeta = LEVEL_META[entry.level];
    const refId = refMeta.refPrefix ? `${refMeta.refPrefix}${entry.index}` : null;
    const data = entry.data;
    const vars = entry.vars;
    const stack = entry.stack;
    const ctx = entry.ctx;

    const allEntries = useEntries();

    // Snapshot diff against the previous snapshot with the same label.
    const snapshotDiff = useMemo(() => {
        if (entry.level !== "snapshot" || !entry.label || !entry.vars) {
            return null;
        }
        const prev = findPreviousSnapshot(allEntries, entry.label, entry.index);
        if (!prev?.vars) {
            return null;
        }
        return { prev, delta: diffVars(prev.vars, entry.vars) };
    }, [allEntries, entry]);

    // Aggregate timer stats for `timer-end` entries with the same label.
    const timerStats = useMemo(() => {
        if (entry.level !== "timer-end" || !entry.label) {
            return null;
        }
        return computeTimerStats(allEntries, entry.label, entry.index);
    }, [allEntries, entry]);

    return (
        <div className="px-4 py-3 bg-black/30 border-t border-white/8 text-[12px] text-white/85">
            <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-wider text-white/40 mb-2">
                <span>#{entry.index}</span>
                {refId ? (
                    <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(refId).catch(() => undefined)}
                        className="text-purple-300 hover:text-purple-200 normal-case tracking-wider"
                        title="copy ref id"
                    >
                        ref: {refId}
                    </button>
                ) : null}
                {entry.h ? (
                    <span className="text-cyan-300">
                        h: <span className="normal-case">{entry.h}</span>
                    </span>
                ) : null}
                {entry.file ? (
                    <span
                        className="text-white/50 normal-case truncate-mono max-w-[24rem]"
                        title={`${entry.file}:${entry.line ?? 0}`}
                    >
                        {entry.file}:{entry.line ?? 0}
                    </span>
                ) : null}
                {entry.durationMs !== undefined ? (
                    <span className="text-purple-300">{entry.durationMs.toFixed(2)}ms</span>
                ) : null}
                {entry.passed !== undefined ? (
                    <span className={entry.passed ? "text-emerald-400" : "text-rose-400"}>
                        {entry.passed ? "✓ pass" : "✗ fail"}
                    </span>
                ) : null}
            </div>

            {entry.label || entry.msg ? (
                <div className="mb-2 text-white/95">
                    {entry.label ? <span className="text-amber-300">{entry.label}</span> : null}
                    {entry.label && entry.msg ? <span className="text-white/40"> · </span> : null}
                    {entry.msg ? <span>{entry.msg}</span> : null}
                </div>
            ) : null}

            {data !== undefined && data !== null ? (
                <Section label="data">
                    <JsonView value={data} />
                </Section>
            ) : null}

            {snapshotDiff ? (
                <Section label={`diff vs prev snapshot (#${snapshotDiff.prev.index})`}>
                    <SnapshotDiffView delta={snapshotDiff.delta} prev={snapshotDiff.prev} />
                </Section>
            ) : null}

            {timerStats ? (
                <Section label={`stats · "${timerStats.label}"`}>
                    <TimerStatsView stats={timerStats} />
                </Section>
            ) : null}

            {vars ? (
                <Section label="vars">
                    <JsonView value={vars} />
                </Section>
            ) : null}

            {ctx !== undefined && ctx !== null ? (
                <Section label="ctx">
                    <JsonView value={ctx} />
                </Section>
            ) : null}

            {stack ? (
                <Section label="stack">
                    <pre className="json-tree text-rose-200/85 whitespace-pre-wrap break-words">{stack}</pre>
                </Section>
            ) : null}
        </div>
    );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
    return (
        <div className="mb-2">
            <div className="text-[9px] uppercase tracking-widest text-white/35 mb-1">{label}</div>
            <div className="pl-2 border-l border-white/8">{children}</div>
        </div>
    );
}

function SnapshotDiffView({ delta, prev }: { delta: SnapshotDelta; prev: IndexedLogEntry }): React.ReactElement {
    const { added, removed, changed, sameCount } = delta;
    const empty = added.length === 0 && removed.length === 0 && changed.length === 0;

    return (
        <div className="font-mono text-[12px] leading-relaxed">
            <div className="text-[10px] text-white/40 mb-1.5">
                vs <span className="text-white/70">#{prev.index}</span> at{" "}
                <span className="text-white/70 tabular-nums">{formatTime(prev.ts)}</span>
                {" · "}
                <span className="text-emerald-400/80">+{added.length}</span>{" "}
                <span className="text-rose-400/80">-{removed.length}</span>{" "}
                <span className="text-amber-300/80">~{changed.length}</span>
                {" · "}
                <span className="text-white/30">{sameCount} unchanged</span>
            </div>
            {empty ? <div className="text-white/35 italic">no changes since previous snapshot</div> : null}
            {added.map(({ key, value }) => (
                <div key={`+${key}`} className="flex gap-2">
                    <span className="text-emerald-400 select-none">+</span>
                    <span className="json-key">{key}</span>
                    <span className="json-bracket">:</span>
                    <span className="flex-1 truncate">
                        <InlineJsonPreview value={value} maxChars={400} />
                    </span>
                </div>
            ))}
            {removed.map(({ key, value }) => (
                <div key={`-${key}`} className="flex gap-2">
                    <span className="text-rose-400 select-none">-</span>
                    <span className="json-key line-through opacity-70">{key}</span>
                    <span className="json-bracket">:</span>
                    <span className="flex-1 truncate opacity-60">
                        <InlineJsonPreview value={value} maxChars={400} />
                    </span>
                </div>
            ))}
            {changed.map(({ key, from, to }) => (
                <div key={`~${key}`} className="flex flex-col gap-0.5">
                    <div className="flex gap-2">
                        <span className="text-amber-300 select-none">~</span>
                        <span className="json-key">{key}</span>
                        <span className="json-bracket">:</span>
                        <span className="flex-1 truncate text-rose-300/80">
                            <InlineJsonPreview value={from} maxChars={400} />
                        </span>
                    </div>
                    <div className="flex gap-2 pl-[1.25rem]">
                        <span className="text-amber-300/60 select-none">→</span>
                        <span className="flex-1 truncate text-emerald-300/90">
                            <InlineJsonPreview value={to} maxChars={400} />
                        </span>
                    </div>
                </div>
            ))}
        </div>
    );
}

function TimerStatsView({ stats }: { stats: TimerStats }): React.ReactElement {
    const items: Array<{ label: string; value: string; tone?: string }> = [
        { label: "runs", value: String(stats.count), tone: "text-purple-300" },
        { label: "last", value: formatDurationMs(stats.lastMs), tone: "text-white/85" },
        { label: "mean", value: formatDurationMs(stats.meanMs), tone: "text-white/85" },
        { label: "p50", value: formatDurationMs(stats.p50Ms) },
        { label: "p95", value: formatDurationMs(stats.p95Ms), tone: "text-amber-300" },
        { label: "min", value: formatDurationMs(stats.minMs), tone: "text-emerald-300" },
        { label: "max", value: formatDurationMs(stats.maxMs), tone: "text-rose-300" },
        { label: "total", value: formatDurationMs(stats.totalMs), tone: "text-white/60" },
    ];

    return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[12px]">
            {items.map((it) => (
                <div key={it.label} className="flex items-baseline gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-white/35 min-w-[2.25rem]">
                        {it.label}
                    </span>
                    <span className={`tabular-nums ${it.tone ?? "text-white/85"}`}>{it.value}</span>
                </div>
            ))}
        </div>
    );
}

function JsonView({ value }: { value: unknown }): React.ReactElement {
    return <pre className="json-tree whitespace-pre-wrap break-words">{render(value, 0, false)}</pre>;
}

/**
 * Render a JSON value as syntax-highlighted JSX. The `trailingComma` flag is
 * threaded through so the comma after a closing bracket lands on the SAME
 * line as the bracket, instead of dropping to its own line beneath it.
 */
function render(value: unknown, depth: number, trailingComma: boolean): React.ReactNode {
    const indent = "  ".repeat(depth);
    const comma = trailingComma ? <span className="json-bracket">,</span> : null;

    if (value === null) {
        return (
            <>
                <span className="json-null">null</span>
                {comma}
            </>
        );
    }
    if (typeof value === "string") {
        return (
            <>
                <span className="json-string">"{escapeStr(value)}"</span>
                {comma}
            </>
        );
    }
    if (typeof value === "number") {
        return (
            <>
                <span className="json-number">{String(value)}</span>
                {comma}
            </>
        );
    }
    if (typeof value === "boolean") {
        return (
            <>
                <span className="json-boolean">{String(value)}</span>
                {comma}
            </>
        );
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return (
                <>
                    <span className="json-bracket">[]</span>
                    {comma}
                </>
            );
        }
        return (
            <>
                <span className="json-bracket">[</span>
                {value.map((v, i) => (
                    <div key={i}>
                        {indent} {render(v, depth + 1, i < value.length - 1)}
                    </div>
                ))}
                <div>
                    {indent}
                    <span className="json-bracket">]</span>
                    {comma}
                </div>
            </>
        );
    }
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) {
            return (
                <>
                    <span className="json-bracket">{"{}"}</span>
                    {comma}
                </>
            );
        }
        return (
            <>
                <span className="json-bracket">{"{"}</span>
                {entries.map(([k, v], i) => (
                    <div key={k}>
                        {indent} <span className="json-key">"{k}"</span>
                        <span className="json-bracket">: </span>
                        {render(v, depth + 1, i < entries.length - 1)}
                    </div>
                ))}
                <div>
                    {indent}
                    <span className="json-bracket">{"}"}</span>
                    {comma}
                </div>
            </>
        );
    }
    return (
        <>
            <span className="json-null">{String(value)}</span>
            {comma}
        </>
    );
}

function escapeStr(s: string): string {
    // Backslash first — must run before others so we don't double-escape the
    // backslashes we're about to introduce. CR/tab matter for log payloads
    // (Windows newlines, ANSI shell output) so they render as visible escape
    // sequences instead of mangling layout.
    return s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
}
