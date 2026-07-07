import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";

interface LiveSseIndicatorProps {
    live: boolean;
    count: number;
}

export function LiveSseIndicator({ live, count }: LiveSseIndicatorProps) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span
                    className="inline-flex items-center gap-1.5 text-xs"
                    style={{ color: live ? "var(--dd-text-muted)" : "var(--dd-danger)" }}
                >
                    <span
                        className={
                            live
                                ? "h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.55)]"
                                : "h-1.5 w-1.5 rounded-full bg-[var(--dd-danger)]"
                        }
                        aria-hidden
                    />
                    <span>{live ? "live (SSE)" : "disconnected"}</span>
                    <span>·</span>
                    <span>{count} shown</span>
                </span>
            </TooltipTrigger>
            <TooltipContent>
                {live ? "Live stream connected" : "SSE stream disconnected — reconnecting…"}
            </TooltipContent>
        </Tooltip>
    );
}
