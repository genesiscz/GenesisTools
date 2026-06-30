import type { LogLevel } from "@app/debugging-master/types";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { sessionKey } from "@app/utils/log-viewer/session-key";
import type { FilterState } from "@/lib/filters";
import { FILTER_ORDER, LEVEL_META } from "@/lib/levels";
import { formatSessionHeaderParts } from "@/lib/session-run-context";
import { SessionLiveStatus } from "@/lib/ui/SessionLiveStatus";
import { AutoscrollToggle } from "./AutoscrollToggle";
import { DisplaySettingsButton } from "./DisplaySettingsButton";
import { useDisplaySettings } from "./DisplaySettingsProvider";
import { FullJsonContextToggle } from "./FullJsonContextToggle";
import { LevelTooltip } from "./LevelTooltip";
import { LogSearchControl } from "./LogSearchControl";
import type { LogSearchState } from "./LogSearchPopover";
import { SessionHeaderLine } from "./SessionHeaderLine";

export type SortDir = "asc" | "desc";

interface Props {
    state: FilterState;
    hypotheses: string[];
    paused: boolean;
    sortDir: SortDir;
    session?: DashboardSession;
    latestLineTs?: number;
    logSearch: LogSearchState;
    onLogSearchChange: (next: LogSearchState) => void;
    logMatchCount: number;
    logLineCount: number;
    onToggleLevel: (level: LogLevel) => void;
    onToggleAll: () => void;
    onChangeHypothesis: (h: string | "all") => void;
    onTogglePause: () => void;
    onToggleSort: () => void;
}

export function FilterBar({
    state,
    hypotheses,
    paused,
    sortDir,
    session,
    latestLineTs,
    logSearch,
    onLogSearchChange,
    logMatchCount,
    logLineCount,
    onToggleLevel,
    onToggleAll,
    onChangeHypothesis,
    onTogglePause,
    onToggleSort,
}: Props): React.ReactElement {
    const { settings, updateSettings } = useDisplaySettings();
    const allOn = state.levels.size === FILTER_ORDER.length;
    const sessionContext = session ? formatSessionHeaderParts(session) : null;
    const showSessionContext = Boolean(sessionContext?.cwd || sessionContext?.command);
    const paneKey = session ? sessionKey(session.source, session.name) : undefined;

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

            <div className="flex flex-wrap items-center gap-2 min-w-0">
                <select
                    aria-label="hypothesis filter"
                    value={state.hypothesis}
                    onChange={(e) => onChangeHypothesis(e.target.value)}
                    className="bg-black/40 border border-white/10 text-white/80 text-xs px-2 py-1 rounded focus:outline-none focus:border-purple-500/50 disabled:opacity-30 shrink-0"
                    disabled={hypotheses.length === 0}
                >
                    <option value="all">h: all</option>
                    {hypotheses.map((h) => (
                        <option key={h} value={h}>
                            h: {h}
                        </option>
                    ))}
                </select>

                <LogSearchControl
                    logSearch={logSearch}
                    onLogSearchChange={onLogSearchChange}
                    matchCount={logMatchCount}
                    lineCount={logLineCount}
                />
                <DisplaySettingsButton variant="log" paneKey={paneKey} />
                {logSearch.query.trim().length > 0 ? (
                    <span className="dbg-ui-text-xs text-white/35 truncate min-w-0 flex-1">
                        {logSearch.frozen ? (
                            <span className="text-amber-300/85 uppercase tracking-wider mr-1.5">frozen</span>
                        ) : null}
                        fuzzy: <span className="text-cyan-400/80">{logSearch.query.trim()}</span>
                    </span>
                ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                {session ? (
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0 flex-1">
                        <SessionLiveStatus
                            session={session}
                            latestLineTs={latestLineTs}
                            className="dbg-ui-text-sm shrink-0"
                        />
                        {showSessionContext ? (
                            <>
                                <span className="text-white/20 shrink-0">·</span>
                                <SessionHeaderLine session={session} layout="context" className="min-w-0" />
                            </>
                        ) : null}
                    </div>
                ) : (
                    <div className="flex-1" />
                )}

                <div className="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        onClick={onToggleSort}
                        className="dbg-ui-btn uppercase tracking-wider px-2.5 py-1 border rounded-md transition-colors text-white/70 border-white/10 hover:border-cyan-500/40 hover:text-white/95"
                        title={
                            sortDir === "asc"
                                ? "showing oldest → newest (newest at bottom)"
                                : "showing newest → oldest (newest at top)"
                        }
                    >
                        {sortDir === "asc" ? "↓ newest" : "↑ newest"}
                    </button>
                    <AutoscrollToggle paused={paused} onToggle={onTogglePause} />
                    <FullJsonContextToggle
                        enabled={settings.fullJsonContext}
                        onToggle={() => {
                            updateSettings({ fullJsonContext: !settings.fullJsonContext });
                        }}
                    />
                </div>
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
