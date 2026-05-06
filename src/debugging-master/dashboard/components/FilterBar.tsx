import type { LogLevel } from "@app/debugging-master/types";
import type { FilterState } from "@/lib/filters";
import { FILTER_ORDER, LEVEL_META } from "@/lib/levels";
import { LevelTooltip } from "./LevelTooltip";

export type SortDir = "asc" | "desc";

interface Props {
    state: FilterState;
    hypotheses: string[];
    paused: boolean;
    sortDir: SortDir;
    onToggleLevel: (level: LogLevel) => void;
    onToggleAll: () => void;
    onChangeHypothesis: (h: string | "all") => void;
    onChangeSearch: (s: string) => void;
    onTogglePause: () => void;
    onToggleSort: () => void;
}

export function FilterBar({
    state,
    hypotheses,
    paused,
    sortDir,
    onToggleLevel,
    onToggleAll,
    onChangeHypothesis,
    onChangeSearch,
    onTogglePause,
    onToggleSort,
}: Props): React.ReactElement {
    const allOn = state.levels.size === FILTER_ORDER.length;

    return (
        <div className="sticky top-[3.25rem] sm:top-[3.5rem] z-10 glass-card border-b border-white/8 px-3 sm:px-5 py-2.5 flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
                <button
                    type="button"
                    onClick={onToggleAll}
                    className="filter-pill text-white/80"
                    data-active={allOn ? "true" : "false"}
                    style={{ color: "rgb(var(--lvl-purple, 168 85 247))" }}
                    title={allOn ? "deselect all" : "select all"}
                >
                    {allOn ? "all" : "none"}
                </button>
                {FILTER_ORDER.map((lvl) => {
                    const active = state.levels.has(lvl);
                    return (
                        <LevelTooltip key={lvl} level={lvl}>
                            <button
                                type="button"
                                onClick={() => onToggleLevel(lvl)}
                                className="filter-pill"
                                data-active={active ? "true" : "false"}
                                data-lvl={lvl}
                                style={levelColorStyle(lvl)}
                            >
                                {LEVEL_META[lvl].label}
                            </button>
                        </LevelTooltip>
                    );
                })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <select
                    aria-label="hypothesis filter"
                    value={state.hypothesis}
                    onChange={(e) => onChangeHypothesis(e.target.value)}
                    className="bg-black/40 border border-white/10 text-white/80 text-xs px-2 py-1 rounded focus:outline-none focus:border-purple-500/50 disabled:opacity-30"
                    disabled={hypotheses.length === 0}
                >
                    <option value="all">h: all</option>
                    {hypotheses.map((h) => (
                        <option key={h} value={h}>
                            h: {h}
                        </option>
                    ))}
                </select>

                <input
                    type="text"
                    placeholder="search…"
                    value={state.search}
                    onChange={(e) => onChangeSearch(e.target.value)}
                    className="flex-1 min-w-[8rem] bg-black/40 border border-white/10 text-white/90 text-xs px-2.5 py-1 rounded placeholder:text-white/30 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
                />

                <button
                    type="button"
                    onClick={onToggleSort}
                    className="text-[10px] uppercase tracking-wider px-2.5 py-1 border rounded-md transition-colors text-white/70 border-white/10 hover:border-cyan-500/40 hover:text-white/95"
                    title={
                        sortDir === "asc"
                            ? "showing oldest → newest (newest at bottom)"
                            : "showing newest → oldest (newest at top)"
                    }
                >
                    {sortDir === "asc" ? "↓ newest" : "↑ newest"}
                </button>
                <button
                    type="button"
                    onClick={onTogglePause}
                    className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider px-2.5 py-1 border rounded-md transition-colors"
                    style={
                        paused
                            ? {
                                  color: "var(--lvl-error)",
                                  borderColor: "rgba(244,63,94,0.45)",
                                  background: "rgba(244,63,94,0.08)",
                              }
                            : {
                                  color: "var(--lvl-checkpoint)",
                                  borderColor: "rgba(16,185,129,0.45)",
                                  background: "rgba(16,185,129,0.08)",
                              }
                    }
                    title={paused ? "click to resume autoscroll" : "click to pause autoscroll"}
                >
                    <span className={paused ? "status-dot status-down" : "status-dot status-live"} />
                    {paused ? "paused" : "autoscroll"}
                </button>
            </div>
        </div>
    );
}

function levelColorStyle(level: LogLevel): React.CSSProperties {
    const map: Record<LogLevel, string> = {
        dump: "var(--lvl-dump)",
        info: "var(--lvl-info)",
        warn: "var(--lvl-warn)",
        error: "var(--lvl-error)",
        "timer-start": "var(--lvl-timer)",
        "timer-end": "var(--lvl-timer)",
        checkpoint: "var(--lvl-checkpoint)",
        assert: "var(--lvl-checkpoint)",
        snapshot: "var(--lvl-snapshot)",
        trace: "var(--lvl-trace)",
        raw: "var(--lvl-raw)",
    };
    return { color: map[level] };
}
