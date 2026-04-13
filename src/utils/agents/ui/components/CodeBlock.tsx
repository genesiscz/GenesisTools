import { AppleWindow } from "@ui/custom/apple-window";
import { cn } from "@ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";

interface CodeBlockProps {
    code: string;
    language?: string;
    filename?: string;
    className?: string;
}

export function CodeBlock({ code, language, filename, className }: CodeBlockProps) {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard API may fail in some contexts
        }
    }, [code]);

    const label = filename || language;

    return (
        <AppleWindow
            title={label}
            rightSlot={
                <button
                    type="button"
                    onClick={handleCopy}
                    className={cn(
                        "flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors",
                        "hover:bg-white/5 text-muted-foreground/60 hover:text-muted-foreground"
                    )}
                >
                    {copied ? (
                        <>
                            <Check className="w-3 h-3 text-green-400" />
                            <span className="text-green-400">Copied!</span>
                        </>
                    ) : (
                        <>
                            <Copy className="w-3 h-3" />
                            <span>Copy</span>
                        </>
                    )}
                </button>
            }
            className={className}
        >
            <pre className="hljs text-xs leading-relaxed overflow-x-auto p-0 m-0 bg-transparent">
                {/* biome-ignore lint/security/noDangerouslySetInnerHtml: rendering highlight.js output, not user-supplied HTML */}
                <code dangerouslySetInnerHTML={{ __html: code }} />
            </pre>
        </AppleWindow>
    );
}
