import { IconPopover } from "@ui/components/icon-button";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Slider } from "@ui/components/slider";
import { Search } from "lucide-react";
import type { ReactElement } from "react";

export interface LogSearchState {
    query: string;
    contextLines: number;
}

export const DEFAULT_LOG_SEARCH: LogSearchState = {
    query: "",
    contextLines: 2,
};

interface Props {
    value: LogSearchState;
    onChange: (next: LogSearchState) => void;
    matchCount: number;
    lineCount: number;
}

export function LogSearchPopover({ value, onChange, matchCount, lineCount }: Props): ReactElement {
    const active = value.query.trim().length > 0;

    return (
        <IconPopover
            tooltip="Search logs (fuzzy)"
            align="end"
            side="bottom"
            contentClassName="w-[min(20rem,calc(100vw-2rem))] border-white/10 bg-[var(--dbg-bg-elev)] p-3 text-[var(--dbg-fg)] shadow-lg shadow-black/40"
            trigger={
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={`h-7 w-7 shrink-0 border border-transparent hover:border-cyan-500/30 ${
                        active ? "text-cyan-400/90 bg-cyan-500/10" : "text-white/50 hover:text-white/85"
                    }`}
                    aria-pressed={active}
                >
                    <Search className="h-3.5 w-3.5" />
                </Button>
            }
        >
            <div className="space-y-3">
                <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
                    <Input
                        type="search"
                        placeholder="Fuzzy search — tokens split on spaces"
                        value={value.query}
                        onChange={(event) => {
                            onChange({ ...value, query: event.target.value });
                        }}
                        className="h-8 border-white/10 bg-black/40 pl-8 text-xs text-white/90 placeholder:text-white/30 focus-visible:border-cyan-500/50 focus-visible:ring-cyan-500/20"
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
                        onValueChange={(next) => {
                            onChange({ ...value, contextLines: next[0] ?? 0 });
                        }}
                        className="py-1"
                    />
                </div>

                <p className="dbg-ui-text-xs text-white/40 tabular-nums">
                    {active ? (
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
