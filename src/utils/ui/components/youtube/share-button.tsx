import { logger } from "@app/logger/client";
import { Check, Loader2, Share2 } from "lucide-react";
import { useState } from "react";

/** Clipboard write with a legacy fallback: `navigator.clipboard` can reject in
 *  an extension content-script world (permissions-policy / focus quirks), and
 *  when it does the user just saw a share button do nothing. The textarea +
 *  execCommand path still works there. */
export async function copyText(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch (error) {
        logger.debug({ error }, "share-button: clipboard API rejected, falling back to execCommand");
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();

    if (!ok) {
        throw new Error("clipboard unavailable");
    }
}

export function ShareButton({
    onShare,
    onCopied,
    onRequireLogin,
    className,
}: {
    onShare: () => Promise<{ url: string }>;
    /** Fires when the link lands on the clipboard — lets the caller render its
     *  own "Link copied" line in addition to the button's chip. */
    onCopied?: () => void;
    /** Opens the sign-in surface when the share endpoint bounced with 401; the
     *  button passes itself as `retry` so login completes the share. */
    onRequireLogin?: (retry?: () => void) => void;
    className?: string;
}) {
    const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    async function click() {
        if (state === "busy") {
            return;
        }

        setState("busy");
        setErrorMessage(null);
        try {
            const { url } = await onShare();
            await copyText(url);
            setState("done");
            onCopied?.();
            setTimeout(() => setState("idle"), 2000);
        } catch (error) {
            logger.warn({ error }, "share-button: share failed");
            const message = error instanceof Error ? error.message : String(error);

            if (message === "login required" && onRequireLogin) {
                setState("idle");
                onRequireLogin(() => void click());
                return;
            }

            setErrorMessage(message);
            setState("error");
            setTimeout(() => setState("idle"), 3000);
        }
    }

    return (
        <span className="relative inline-flex">
            <button
                type="button"
                onClick={() => void click()}
                title="Share (copies link)"
                className={`inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${className ?? ""}`}
            >
                {state === "busy" ? (
                    <Loader2 className="size-4 animate-spin" />
                ) : state === "done" ? (
                    <Check className="size-4 text-primary" />
                ) : (
                    <Share2 className={`size-4 ${state === "error" ? "text-destructive/90" : ""}`} />
                )}
            </button>
            {state === "done" ? (
                <span className="absolute right-0 top-full z-20 mt-1 whitespace-nowrap rounded-md border border-primary/30 bg-card px-2 py-1 text-xs text-foreground shadow-lg">
                    Link copied
                </span>
            ) : state === "error" && errorMessage ? (
                <span className="absolute right-0 top-full z-20 mt-1 max-w-56 truncate whitespace-nowrap rounded-md border border-destructive/40 bg-card px-2 py-1 text-xs text-destructive shadow-lg">
                    {errorMessage}
                </span>
            ) : null}
        </span>
    );
}
