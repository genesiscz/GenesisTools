import { Check, Loader2, Share2 } from "lucide-react";
import { useState } from "react";

export function ShareButton({
    onShare,
    onCopied,
    className,
}: {
    onShare: () => Promise<{ url: string }>;
    /** Fires when the link lands on the clipboard — lets the caller render the
     *  "Link copied" line below its own header instead of duplicating state. */
    onCopied?: () => void;
    className?: string;
}) {
    const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

    async function click() {
        if (state === "busy") {
            return;
        }

        setState("busy");
        try {
            const { url } = await onShare();
            await navigator.clipboard.writeText(url);
            setState("done");
            onCopied?.();
            setTimeout(() => setState("idle"), 2000);
        } catch {
            setState("error");
            setTimeout(() => setState("idle"), 2500);
        }
    }

    return (
        <button
            type="button"
            onClick={() => void click()}
            title="Share (copies link)"
            className={`inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground ${className ?? ""}`}
        >
            {state === "busy" ? (
                <Loader2 className="size-4 animate-spin" />
            ) : state === "done" ? (
                <Check className="size-4 text-primary" />
            ) : (
                <Share2 className={`size-4 ${state === "error" ? "text-destructive/90" : ""}`} />
            )}
        </button>
    );
}
