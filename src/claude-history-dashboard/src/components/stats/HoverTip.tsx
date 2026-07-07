import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import type { ReactElement, ReactNode } from "react";

interface HoverTipProps {
	tip: ReactNode;
	children: ReactElement;
}

export function HoverTip({ tip, children }: HoverTipProps) {
	if (!tip) {
		return children;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent className="font-mono text-xs">{tip}</TooltipContent>
		</Tooltip>
	);
}
