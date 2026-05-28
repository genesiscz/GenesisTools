import { formatQaAsHtml, formatQaAsMarkdown } from "@app/dev-dashboard/lib/qa-clipboard";
import type { QaRow } from "@app/dev-dashboard/lib/qa-types";
import { Button } from "@ui/components/button";
import { FileText, FileType2, NotebookPen } from "lucide-react";
import { useState } from "react";

export function QaCopyButtons({ entry, onSaveToObsidian }: { entry: QaRow; onSaveToObsidian: () => void }) {
    const [copied, setCopied] = useState<"md" | "html" | "error" | null>(null);

    const copy = async (kind: "md" | "html"): Promise<void> => {
        try {
            if (kind === "md") {
                await navigator.clipboard.writeText(formatQaAsMarkdown(entry));
            } else {
                const html = formatQaAsHtml(entry);
                const md = formatQaAsMarkdown(entry);

                await navigator.clipboard.write([
                    new ClipboardItem({
                        "text/html": new Blob([html], { type: "text/html" }),
                        "text/plain": new Blob([md], { type: "text/plain" }),
                    }),
                ]);
            }

            setCopied(kind);
        } catch {
            // navigator.clipboard rejects on permission denial or insecure context.
            setCopied("error");
        }

        setTimeout(() => setCopied(null), 1200);
    };

    return (
        <div className="inline-flex items-center gap-1">
            <Button
                size="icon"
                variant="ghost"
                aria-label="Copy as Markdown"
                title="Copy as Markdown"
                onClick={() => void copy("md")}
            >
                {copied === "md" ? (
                    <span className="text-xs">✓</span>
                ) : copied === "error" ? (
                    <span className="text-xs text-[var(--dd-danger)]">!</span>
                ) : (
                    <FileText className="h-3.5 w-3.5" />
                )}
            </Button>
            <Button
                size="icon"
                variant="ghost"
                aria-label="Copy as formatted"
                title="Copy as formatted (rich text)"
                onClick={() => void copy("html")}
            >
                {copied === "html" ? (
                    <span className="text-xs">✓</span>
                ) : copied === "error" ? (
                    <span className="text-xs text-[var(--dd-danger)]">!</span>
                ) : (
                    <FileType2 className="h-3.5 w-3.5" />
                )}
            </Button>
            <Button
                size="icon"
                variant="ghost"
                aria-label="Save to Obsidian"
                title="Save to Obsidian"
                onClick={onSaveToObsidian}
            >
                <NotebookPen className="h-3.5 w-3.5" />
            </Button>
        </div>
    );
}
