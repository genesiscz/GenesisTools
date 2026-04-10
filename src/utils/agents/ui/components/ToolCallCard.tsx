import { SafeJSON } from "@app/utils/json";
import { cn } from "@ui/lib/utils";
import { ChevronRight, Terminal, XCircle } from "lucide-react";

import type { ToolCallCardProps } from "../types";
import { DiffView } from "./DiffView";

const RESULT_COLLAPSE_THRESHOLD = 300;

export function ToolCallCard({
    name,
    signature,
    diffLines,
    resultContent,
    isError = false,
    defaultExpanded = false,
}: ToolCallCardProps) {
    const isResultLong = (resultContent?.length ?? 0) > RESULT_COLLAPSE_THRESHOLD;

    return (
        <div className="rounded-md border border-amber-500/15 bg-black/20 overflow-hidden">
            <details className="group" {...(defaultExpanded ? { open: true } : {})}>
                <summary
                    className={cn(
                        "flex items-center gap-2 px-3 py-2 cursor-pointer list-none text-sm",
                        "hover:bg-amber-500/5 select-none transition-colors"
                    )}
                >
                    <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform group-open:rotate-90 text-amber-500/50" />

                    <Terminal className="w-3 h-3 shrink-0 text-amber-500/40" />

                    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-mono font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        {name}
                    </span>

                    <span className="font-mono text-xs text-muted-foreground/50 truncate min-w-0">{signature}</span>

                    {isError && (
                        <span className="inline-flex items-center gap-1 ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">
                            <XCircle className="w-3 h-3" />
                            Error
                        </span>
                    )}
                </summary>

                <div className="border-t border-amber-500/10 px-3 pb-3 pt-2 space-y-2">
                    {diffLines && diffLines.length > 0 && <DiffView lines={diffLines} />}

                    {resultContent && <ResultBlock content={resultContent} isError={isError} isLong={isResultLong} />}
                </div>
            </details>
        </div>
    );
}

interface ResultBlockProps {
    content: string;
    isError: boolean;
    isLong: boolean;
}

function formatContent(raw: string): string {
    const trimmed = raw.trim();

    // Only attempt JSON parse for object/array literals (not e.g. "[rerun: b2]")
    if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[{") && trimmed.endsWith("]")) ||
        (trimmed.startsWith('["') && trimmed.endsWith("]"))
    ) {
        const parsed = SafeJSON.parse(trimmed);

        if (parsed != null) {
            return SafeJSON.stringify(parsed, null, 2) ?? raw;
        }
    }

    return raw;
}

function ResultBlock({ content, isError, isLong }: ResultBlockProps) {
    const formatted = formatContent(content);

    const preClasses = cn(
        "text-xs p-3 rounded-md overflow-auto whitespace-pre-wrap font-mono border",
        isError
            ? "bg-red-500/5 border-red-500/15 text-red-300/80"
            : "bg-black/30 border-white/5 text-muted-foreground/70"
    );

    if (!isLong) {
        return (
            <pre className={preClasses}>
                <code>{formatted}</code>
            </pre>
        );
    }

    return (
        <details className="group/result">
            <summary className="text-xs text-muted-foreground/40 cursor-pointer select-none hover:text-muted-foreground/70 transition-colors font-mono">
                Result ({content.length} chars) -- click to expand
            </summary>
            <pre className={cn(preClasses, "mt-1.5")}>
                <code>{formatted}</code>
            </pre>
        </details>
    );
}
