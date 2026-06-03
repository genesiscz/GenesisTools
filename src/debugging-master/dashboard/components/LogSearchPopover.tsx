import { IconPopover } from "@ui/components/icon-button";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Slider } from "@ui/components/slider";
import { Search } from "lucide-react";
import type { ReactElement } from "react";

export interface LogSearchState {
    query: string;
    contextLines: number;
    /** When true, the query stays visible but filtering is paused for line-jump context. */
    frozen?: boolean;
}

export const DEFAULT_LOG_SEARCH: LogSearchState = {
    query: "",
    contextLines: 2,
    frozen: false,
};

export const LOG_SEARCH_FROZEN_TOOLTIP =
    "Search frozen for line jump — open to unfreeze and restore filtering";

export function freezeLogSearch(state: LogSearchState): LogSearchState {
    if (!state.query.trim()) {
        return state;
    }

    return { ...state, frozen: true };
}

export function unfreezeLogSearch(state: LogSearchState): LogSearchState {
    if (!state.frozen) {
        return state;
    }

    return { ...state, frozen: false };
}

interface Props {
    value: LogSearchState;
    onChange: (next: LogSearchState) => void;
    matchCount: number;
    lineCount: number;
}

export function LogSearchPopover({ value, onChange, matchCount, lineCount }: Props): ReactElement {
    const active = value.query.trim().length > 0;
    const frozen = Boolean(active && value.frozen);

    return (
        <IconPopover
            tooltip={frozen ? LOG_SEARCH_FROZEN_TOOLTIP : "Search logs (fuzzy)"}
            align="end"
            side="bottom"
            contentClassName="w-[min(20rem,calc(100vw-2rem))] border-white/10 bg-[var(--dbg-bg-elev)] p-3 text-[var(--dbg-fg)] shadow-lg shadow-black/40"
            trigger={
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={`h-7 w-7 shrink-0 border border-transparent hover:border-cyan-500/30 ${
                        frozen
                            ? "text-amber-300/95 bg-amber-500/15 border-amber-400/35"
                            : active
                              ? "text-cyan-400/90 bg-cyan-500/10"
                              : "text-white/50 hover:text-white/85"
                    }`}
                    aria-pressed={active}
                >
                    <Search className="h-3.5 w-3.5" />
                </Button>
            }
        >
            <div className="space-y-3">
                {frozen ? (
                    <div className="rounded-md border border-amber-400/25 bg-amber-500/10 px-2.5 py-2 space-y-2">
                        <p className="dbg-ui-text-xs text-amber-100/90 leading-relaxed">
                            Search is frozen so you can read full context around a jumped line. The query below is
                            kept — unfreeze to apply filtering again.
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                onChange(unfreezeLogSearch(value));
                            }}
                            className="dbg-ui-text-xs uppercase tracking-wider text-amber-200/90 hover:text-amber-100"
                        >
                            Unfreeze search
                        </button>
                    </div>
                ) : null}

                <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
                    <Input
                        type="search"
                        placeholder="Fuzzy search — tokens split on spaces"
                        value={value.query}
                        readOnly={frozen}
                        onChange={(event) => {
                            onChange({ ...value, query: event.target.value, frozen: false });
                        }}
                        className={`h-8 border-white/10 bg-black/40 pl-8 text-xs text-white/90 placeholder:text-white/30 focus-visible:border-cyan-500/50 focus-visible:ring-cyan-500/20 ${
                            frozen ? "opacity-80 cursor-default" : ""
                        }`}
                        autoFocus
                    />
                </div>

                <div className="space-y-1.5">
                    <div className="flex items-center justify-between dbg-ui-text-xs text-white/50">
                        <span>Context lines</span>
                        <span className="tabular-nums text-cyan-400/80">{value.contextLines}</span>
                    </div>
                    <Slider
                        min={0}
                        max={20}
                        step={1}
                        value={[value.contextLines]}
                        disabled={frozen}
                        onValueChange={(next) => {
                            onChange({ ...value, contextLines: next[0] ?? 0 });
                        }}
                        className="py-1"
                    />
                </div>

                <p className="dbg-ui-text-xs text-white/40 tabular-nums">
                    {frozen ? (
                        <>
                            <span className="text-amber-300/90">frozen</span>
                            {" · "}
                            <span className="text-cyan-400/80">{matchCount}</span> match{matchCount === 1 ? "" : "es"}{" "}
                            in query · {lineCount} line{lineCount === 1 ? "" : "s"} shown (all)
                        </>
                    ) : active ? (
                        <>
                            <span className="text-cyan-400/80">{matchCount}</span> match{matchCount === 1 ? "" : "es"}
                            {" · "}
                            {lineCount} line{lineCount === 1 ? "" : "s"} shown
                        </>
                    ) : (
                        <>Searching {lineCount} lines</>
                    )}
                </p>
            </div>
        </IconPopover>
    );
}
