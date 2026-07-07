import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import type { CSSProperties, ReactElement } from "react";

interface Props {
    enabled: boolean;
    onToggle: () => void;
    className?: string;
}

export function FullJsonContextToggle({ enabled, onToggle, className = "" }: Props): ReactElement {
    const style: CSSProperties = enabled
        ? {
              color: "var(--lvl-info)",
              borderColor: "rgba(56,189,248,0.45)",
              background: "rgba(56,189,248,0.08)",
          }
        : {
              color: "rgba(255,255,255,0.55)",
              borderColor: "rgba(255,255,255,0.12)",
              background: "transparent",
          };

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={onToggle}
                    className={`dbg-ui-btn inline-flex items-center gap-1.5 uppercase tracking-wider px-2.5 py-1 border rounded-md transition-colors ${className}`}
                    style={style}
                >
                    {enabled ? "full json" : "slice json"}
                </button>
            </TooltipTrigger>
            <TooltipContent>
                {enabled
                    ? "Showing full JSON context lines (click for truncated preview)"
                    : "Showing truncated JSON context (click for full copy-pasteable JSON)"}
            </TooltipContent>
        </Tooltip>
    );
}
