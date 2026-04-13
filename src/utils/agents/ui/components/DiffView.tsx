import { cn } from "@ui/lib/utils";
import { FileCode } from "lucide-react";
import { useMemo } from "react";

import { useExpandable } from "../hooks/useExpandable";
import type { DiffViewProps } from "../types";

const DEFAULT_MAX_COLLAPSED = 40;

function lineClass(line: string): string {
    if (line.startsWith("+")) {
        return "text-green-400/90 bg-green-500/10 border-l-2 border-l-green-500/40";
    }

    if (line.startsWith("-")) {
        return "text-red-400/90 bg-red-500/10 border-l-2 border-l-red-500/40";
    }

    if (line.startsWith("@@")) {
        return "text-cyan-400/60 bg-cyan-500/[0.04] border-l-2 border-l-cyan-500/20";
    }

    return "text-muted-foreground/50 border-l-2 border-l-transparent";
}

export function DiffView({ lines, filePath, maxCollapsedLines }: DiffViewProps) {
    const limit = maxCollapsedLines ?? DEFAULT_MAX_COLLAPSED;
    const isLong = lines.length > limit;
    const { expanded, toggle } = useExpandable(!isLong);

    const visibleLines = useMemo(() => {
        if (expanded) {
            return lines;
        }

        return lines.slice(0, limit);
    }, [expanded, lines, limit]);

    const hiddenCount = lines.length - limit;

    return (
        <div className="rounded-md border border-white/[0.06] bg-black/40 overflow-hidden">
            {filePath && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground/50 border-b border-white/[0.06] font-mono truncate bg-black/20">
                    <FileCode className="w-3 h-3 shrink-0 text-amber-500/40" />
                    {filePath}
                </div>
            )}

            <pre className="px-1 py-2 text-xs leading-5 overflow-x-auto">
                {visibleLines.map((line, idx) => (
                    <div key={idx} className={cn("font-mono px-2 py-px rounded-sm", lineClass(line))}>
                        {line || " "}
                    </div>
                ))}
            </pre>

            {isLong && (
                <button
                    type="button"
                    onClick={toggle}
                    className={cn(
                        "w-full px-3 py-1.5 text-xs font-mono text-center cursor-pointer transition-colors",
                        "text-amber-500/50 hover:text-amber-400 hover:bg-amber-500/5",
                        "border-t border-white/[0.06]"
                    )}
                >
                    {expanded ? "-- show less --" : `-- ${hiddenCount} more line${hiddenCount === 1 ? "" : "s"} --`}
                </button>
            )}
        </div>
    );
}
