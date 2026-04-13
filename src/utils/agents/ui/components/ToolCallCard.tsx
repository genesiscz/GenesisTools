import { SafeJSON } from "@app/utils/json";
import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib/utils";
import { Minus, Plus, Wrench, XCircle } from "lucide-react";
import { useState } from "react";

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
    const [isOpen, setIsOpen] = useState(defaultExpanded && hasContent);
    const isPending = !isError && !resultContent;
    const status = isError ? "ERROR" : resultContent ? "COMPLETED" : "PENDING";
    const statusVariant = isError ? "destructive" : isPending ? "outline" : "cyber-secondary";

    return (
        <div
            className={cn(
                "rounded-lg overflow-hidden border transition-all duration-300",
                isError ? "border-destructive/20 bg-destructive/[0.02]" : "border-primary/15",
                isOpen && !isError && "border-primary/40",
                isOpen && isError && "border-destructive/40",
                isOpen ? "collapsible-open" : ""
            )}
        >
            {/* Header */}
            <div
                onClick={hasContent ? () => setIsOpen(!isOpen) : undefined}
                className={cn(
                    "flex items-center gap-3 px-4 py-2 select-none transition-all duration-200",
                    hasContent && "cursor-pointer",
                    hasContent && !isError && "hover:bg-primary/[0.06]",
                    hasContent && isError && "hover:bg-destructive/5",
                    "bg-primary/[0.02]"
                )}
            >
                {/* +/- toggle icon */}
                <div
                    className={cn(
                        "w-5 h-5 rounded flex items-center justify-center shrink-0",
                        isError ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary",
                        !hasContent && "invisible"
                    )}
                >
                    {isOpen ? <Minus className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                </div>

                {/* Wrench icon */}
                <Wrench className={cn("w-3 h-3 shrink-0", isError ? "text-destructive/30" : "text-primary/25")} />

                {/* Tool name badge */}
                <Badge
                    variant={isError ? "destructive" : "cyber"}
                    className="text-[11px] font-mono font-semibold px-1.5 py-0 rounded-md"
                >
                    {name}
                </Badge>

                {/* Signature */}
                <span className="font-mono text-xs text-muted-foreground/35 truncate min-w-0">{signature}</span>

                {/* Status badge -- pushed to right */}
                <Badge
                    variant={statusVariant}
                    className={cn(
                        "ml-auto text-[10px] font-mono gap-1 px-1.5 py-0 shrink-0",
                        isError && "gap-1",
                        isPending && "text-muted-foreground/40 border-muted-foreground/15 animate-pulse"
                    )}
                >
                    {isError && <XCircle className="w-3 h-3" />}
                    {status}
                </Badge>
            </div>

            {/* Collapsible body -- uses CSS animation from styles.css */}
            <div className="collapsible-body">
                {hasContent && (
                    <div
                        className={cn(
                            "px-4 pb-4 pt-3 space-y-2 border-t",
                            isError ? "border-destructive/10" : "border-primary/10"
                        )}
                    >
                        {diffLines && diffLines.length > 0 && <DiffView lines={diffLines} />}

                        {resultContent && (
                            <ResultBlock
                                content={resultContent}
                                isError={isError}
                                toolName={name}
                                signature={signature}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

interface ResultBlockProps {
    content: string;
    isError: boolean;
    toolName?: string;
    signature?: string;
}

const EXT_TO_LANG: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    css: "css",
    html: "html",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    md: "markdown",
    xml: "xml",
};

function inferLanguage(toolName?: string, signature?: string): string | undefined {
    if (!signature) {
        return undefined;
    }

    // Extract file extension from path in signature
    const pathMatch = signature.match(/[\w/.-]+\.([\w]+)/);

    if (pathMatch) {
        return EXT_TO_LANG[pathMatch[1].toLowerCase()];
    }

    // Bash tool results are shell output
    if (toolName === "Bash") {
        return "bash";
    }

    return undefined;
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

function ResultBlock({ content, isError, toolName, signature }: ResultBlockProps) {
    const { text, isStructured } = extractResultText(content);
    const lang = inferLanguage(toolName, signature);

    // Structured text (extracted from Agent SDK blocks) — render as markdown
    // If we inferred a language, wrap in a fenced code block for syntax highlighting
    if (isStructured) {
        const rendered = lang ? `\`\`\`${lang}\n${text}\n\`\`\`` : text;

        return (
            <div
                className={cn(
                    "rounded-md border overflow-auto bg-black/40",
                    lang ? "p-0" : "p-3",
                    isError ? "border-destructive/15" : "border-white/[0.06]"
                )}
                style={{ maxHeight: RESULT_MAX_HEIGHT }}
            >
                <MarkdownRenderer content={rendered} className="text-xs leading-relaxed" />
            </div>
        );
    }

    // Raw text / JSON — wrap in fenced code block for syntax highlighting when language is known
    if (lang) {
        const rendered = `\`\`\`${lang}\n${text}\n\`\`\``;

        return (
            <div
                className={cn(
                    "rounded-md border overflow-auto bg-black/40",
                    isError ? "border-destructive/15" : "border-white/[0.06]"
                )}
                style={{ maxHeight: RESULT_MAX_HEIGHT }}
            >
                <MarkdownRenderer content={rendered} className="text-xs leading-relaxed" />
            </div>
        );
    }

    // Fallback: raw text without syntax highlighting
    return (
        <pre
            className={cn(
                "text-xs p-3 rounded-md overflow-auto whitespace-pre-wrap break-words font-mono bg-black/40 border",
                isError ? "border-destructive/15 text-destructive/80" : "border-white/[0.06] text-muted-foreground/60"
            )}
            style={{ maxHeight: RESULT_MAX_HEIGHT }}
        >
            <code>{text}</code>
        </pre>
    );
}
