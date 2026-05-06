import type { LogLevel } from "@app/debugging-master/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import type { ReactNode } from "react";
import { LEVEL_META } from "@/lib/levels";

interface Props {
    level: LogLevel;
    children: ReactNode;
}

/**
 * Wraps a level chip / pill with a hover tooltip explaining what that level
 * means and how to emit one. Uses Radix Tooltip via shadcn — far more reliable
 * than the browser's native `title=` attribute, which often fails to show
 * inside interactive parents.
 */
export function LevelTooltip({ level, children }: Props): React.ReactElement {
    return (
        <Tooltip>
            <TooltipTrigger asChild>{children}</TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-normal text-left leading-relaxed" sideOffset={6}>
                {LEVEL_META[level].description}
            </TooltipContent>
        </Tooltip>
    );
}
