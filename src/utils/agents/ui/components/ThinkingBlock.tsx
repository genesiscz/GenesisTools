import { cn } from "@ui/lib/utils";
import { Brain } from "lucide-react";

import type { ThinkingBlockProps } from "../types";

export function ThinkingBlock({ content, defaultExpanded = false }: ThinkingBlockProps) {
    return (
        <details
            className={cn(
                "rounded-md border border-purple-500/15 bg-purple-500/[0.03] overflow-hidden",
                "group/thinking"
            )}
            open={defaultExpanded}
        >
            <summary
                className={cn(
                    "flex items-center gap-2 px-3 py-2 cursor-pointer list-none select-none text-sm",
                    "text-purple-400/70 hover:text-purple-400 hover:bg-purple-500/5 transition-colors"
                )}
            >
                <Brain className="w-3.5 h-3.5 shrink-0 text-purple-500/50" />
                <span className="italic font-medium text-xs tracking-wide">Thinking...</span>
                <span className="ml-auto text-[10px] font-mono text-purple-500/30">
                    {content.length > 200 ? `${Math.ceil(content.length / 4)} tokens` : ""}
                </span>
            </summary>

            <div className="border-t border-purple-500/10 px-4 py-3">
                <pre
                    className={cn(
                        "text-xs leading-relaxed whitespace-pre-wrap font-mono",
                        "text-muted-foreground/60 italic"
                    )}
                >
                    {content}
                </pre>
            </div>
        </details>
    );
}
