import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import type { CSSProperties, ReactElement } from "react";

interface Props {
    paused: boolean;
    onToggle: () => void;
    className?: string;
}

export function AutoscrollToggle({ paused, onToggle, className = "" }: Props): ReactElement {
    const style: CSSProperties = paused
        ? {
              color: "var(--lvl-error)",
              borderColor: "rgba(244,63,94,0.45)",
              background: "rgba(244,63,94,0.08)",
          }
        : {
              color: "var(--lvl-checkpoint)",
              borderColor: "rgba(16,185,129,0.45)",
              background: "rgba(16,185,129,0.08)",
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
                    <span className={paused ? "status-dot status-down" : "status-dot status-live"} />
                    {paused ? "paused" : "autoscroll"}
                </button>
            </TooltipTrigger>
            <TooltipContent>{paused ? "click to resume autoscroll" : "click to pause autoscroll"}</TooltipContent>
        </Tooltip>
    );
}
