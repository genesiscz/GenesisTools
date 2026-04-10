import { SafeJSON } from "@app/utils/json";
import { Badge } from "@ui/components/badge";
import { ChevronRight, Wrench } from "lucide-react";

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
        <div className="rounded border border-border bg-muted/20 overflow-hidden">
            <details className="group" {...(defaultExpanded ? { open: true } : {})}>
                <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer list-none text-sm hover:bg-muted/40 select-none">
                    <ChevronRight className="w-4 h-4 shrink-0 transition-transform group-open:rotate-90 text-muted-foreground" />
                    <Wrench className="w-3 h-3 shrink-0 text-muted-foreground" />
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                        {name}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground truncate">{signature}</span>
                    {isError && (
                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0 ml-auto">
                            Error
                        </Badge>
                    )}
                </summary>

                <div className="px-3 pb-3 space-y-2">
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

    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && (trimmed.endsWith("}") || trimmed.endsWith("]"))) {
        const parsed = SafeJSON.parse(trimmed);

        if (parsed != null) {
            return SafeJSON.stringify(parsed, null, 2) ?? raw;
        }
    }

    return raw;
}

function ResultBlock({ content, isError, isLong }: ResultBlockProps) {
    const bgClass = isError ? "bg-red-500/10" : "bg-muted/30";
    const formatted = formatContent(content);

    if (!isLong) {
        return (
            <pre className={`text-xs p-2 rounded overflow-auto whitespace-pre-wrap font-mono ${bgClass}`}>
                <code>{formatted}</code>
            </pre>
        );
    }

    return (
        <details className="group/result">
            <summary className="text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground">
                Result ({content.length} chars) — click to expand
            </summary>
            <pre className={`text-xs p-2 rounded mt-1 overflow-auto whitespace-pre-wrap font-mono ${bgClass}`}>
                <code>{formatted}</code>
            </pre>
        </details>
    );
}
