import { cn } from "@ui/lib/utils";
import { useMemo } from "react";

import { useExpandable } from "../hooks/useExpandable";
import type { DiffViewProps } from "../types";

const DEFAULT_MAX_COLLAPSED = 12;

function lineClass(line: string): string {
    if (line.startsWith("+")) {
        return "text-green-400";
    }

    if (line.startsWith("-")) {
        return "text-red-400";
    }

    return "text-muted-foreground";
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
        <div className="rounded border border-border bg-muted/30 overflow-hidden">
            {filePath && (
                <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border font-mono truncate">
                    {filePath}
                </div>
            )}
            <pre className="px-3 py-2 text-xs leading-5 overflow-x-auto">
                {visibleLines.map((line, idx) => (
                    <div key={idx} className={cn("font-mono", lineClass(line))}>
                        {line}
                    </div>
                ))}
            </pre>
            {isLong && (
                <button
                    type="button"
                    onClick={toggle}
                    className="w-full px-3 py-1.5 text-xs text-primary hover:text-primary/80 border-t border-border text-center cursor-pointer"
                >
                    {expanded ? "Show less" : `Show ${hiddenCount} more line${hiddenCount === 1 ? "" : "s"}`}
                </button>
            )}
        </div>
    );
}
