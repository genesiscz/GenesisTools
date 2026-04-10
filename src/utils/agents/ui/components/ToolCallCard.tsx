import { SafeJSON } from "@app/utils/json";
import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib/utils";
import { ChevronRight, Terminal, XCircle } from "lucide-react";

import type { ToolCallCardProps } from "../types";
import { DiffView } from "./DiffView";
import { MarkdownRenderer } from "./MarkdownRenderer";

const RESULT_MAX_HEIGHT = "24rem";

export function ToolCallCard({
    name,
    signature,
    diffLines,
    resultContent,
    isError = false,
    defaultExpanded = false,
}: ToolCallCardProps) {
    const hasContent = (diffLines && diffLines.length > 0) || !!resultContent;

    return (
        <div className={cn("rounded-md overflow-hidden glass-card", isError ? "border-destructive/20" : "border-primary/15")}>
            <details className="group" {...(defaultExpanded && hasContent ? { open: true } : {})}>
                <summary
                    className={cn(
                        "flex items-center gap-2 px-3 py-2 list-none text-sm select-none",
                        hasContent && "cursor-pointer transition-all duration-200",
                        hasContent &&
                            !isError &&
                            "hover:bg-primary/5 hover:shadow-[0_0_8px_color-mix(in_oklch,var(--color-primary)_15%,transparent)]",
                        hasContent && isError && "hover:bg-destructive/5"
                    )}
                >
                    <ChevronRight
                        className={cn(
                            "w-3.5 h-3.5 shrink-0 transition-transform group-open:rotate-90",
                            isError ? "text-destructive/50" : "text-primary/50",
                            !hasContent && "invisible"
                        )}
                    />

                    <Terminal className={cn("w-3 h-3 shrink-0", isError ? "text-destructive/40" : "text-primary/40")} />

                    <Badge
                        variant={isError ? "destructive" : "cyber"}
                        className="text-[11px] font-mono font-semibold px-1.5 py-0 rounded-md"
                    >
                        {name}
                    </Badge>

                    <span className="font-mono text-xs text-muted-foreground/40 truncate min-w-0">{signature}</span>

                    {isError && (
                        <Badge variant="destructive" className="ml-auto text-[10px] font-mono gap-1 px-1.5 py-0">
                            <XCircle className="w-3 h-3" />
                            Error
                        </Badge>
                    )}
                </summary>

                {hasContent && (
                    <div
                        className={cn(
                            "px-3 pb-3 pt-2 space-y-2 border-t",
                            isError ? "border-destructive/10" : "border-primary/10"
                        )}
                    >
                        {diffLines && diffLines.length > 0 && <DiffView lines={diffLines} />}

                        {resultContent && <ResultBlock content={resultContent} isError={isError} />}
                    </div>
                )}
            </details>
        </div>
    );
}

interface ResultBlockProps {
    content: string;
    isError: boolean;
}

/**
 * Extract human-readable text from structured tool results.
 *
 * Agent SDK tool results are often JSON arrays of {type:"text", text:"..."} blocks.
 * Instead of showing raw JSON, extract and join the text content.
 */
function extractResultText(raw: string): { text: string; isStructured: boolean } {
    const trimmed = raw.trim();

    // Agent SDK format: [{type:"text", text:"..."}, ...] (may be pretty-printed with whitespace)
    const isArrayOfObjects = trimmed.startsWith("[") && trimmed.endsWith("]") && /^\[\s*\{/.test(trimmed);

    if (isArrayOfObjects) {
        const parsed = SafeJSON.parse(trimmed) as Array<{ type?: string; text?: string }> | null;

        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type === "text") {
            const texts = parsed.filter((b) => b.type === "text" && b.text).map((b) => b.text as string);

            if (texts.length > 0) {
                return { text: texts.join("\n\n"), isStructured: true };
            }
        }
    }

    // Single JSON object — pretty-print it (strict prefix check to avoid "[rerun: b2]" etc.)
    if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[{") && trimmed.endsWith("]")) ||
        (trimmed.startsWith('["') && trimmed.endsWith("]"))
    ) {
        const parsed = SafeJSON.parse(trimmed);

        if (parsed != null) {
            return { text: SafeJSON.stringify(parsed, null, 2) ?? raw, isStructured: false };
        }
    }

    return { text: raw, isStructured: false };
}

function ResultBlock({ content, isError }: ResultBlockProps) {
    const { text, isStructured } = extractResultText(content);

    // Structured text (extracted from Agent SDK blocks) — render as markdown
    if (isStructured) {
        return (
            <div
                className={cn(
                    "rounded-md border p-3 overflow-auto glass-card",
                    isError ? "border-destructive/15" : "border-border"
                )}
                style={{ maxHeight: RESULT_MAX_HEIGHT }}
            >
                <MarkdownRenderer content={text} className="text-xs leading-relaxed" />
            </div>
        );
    }

    // Raw text / JSON — render as code with scroll
    return (
        <pre
            className={cn(
                "text-xs p-3 rounded-md overflow-auto whitespace-pre-wrap break-words font-mono glass-card border",
                isError ? "border-destructive/15 text-destructive/80" : "border-border text-muted-foreground/60"
            )}
            style={{ maxHeight: RESULT_MAX_HEIGHT }}
        >
            <code>{text}</code>
        </pre>
    );
}
