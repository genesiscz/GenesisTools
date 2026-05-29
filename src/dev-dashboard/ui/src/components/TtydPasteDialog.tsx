import { Button } from "@ui/components/button";
import {
    GlassDialogBody,
    GlassDialogContent,
    GlassDialogDescription,
    GlassDialogEyebrow,
    GlassDialogFooter,
    GlassDialogHeader,
    GlassDialogShell,
    GlassDialogTitle,
} from "@ui/components/glass-dialog";
import { Textarea } from "@ui/components/textarea";
import { ClipboardPaste, CornerDownLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Inject the typed/pasted text into the terminal. Return value is ignored. */
    onSubmit: (text: string) => void;
}

/**
 * Paste-into-terminal dialog for mobile, where the keybar Paste key can't read
 * the clipboard directly (iOS/Safari deny a programmatic read tied to a stale
 * gesture). Three ways in, all needing no special permission on the open itself:
 *   - "Paste from clipboard" button — `readText()` runs inside *this* button's
 *     click (a fresh gesture on a mounted element), so iOS shows its native
 *     paste-confirm and actually fills the box.
 *   - long-press → Paste into the textarea (a native OS paste, always allowed).
 *   - on Chrome/desktop the box auto-fills from the clipboard on open.
 * Send injects the value via the same `term.paste()` bridge; ⌘/Ctrl+Enter sends.
 */
export function TtydPasteDialog({ open, onOpenChange, onSubmit }: Props) {
    const [value, setValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        if (!open) {
            setValue("");
            return;
        }

        // Best-effort auto-fill on open. Works on Chrome/desktop (no gesture
        // needed there); iOS/Safari/Firefox reject it and the user taps the
        // "Paste from clipboard" button or long-press-pastes instead.
        let cancelled = false;
        navigator.clipboard
            ?.readText?.()
            .then((text) => {
                if (!cancelled && text) {
                    setValue((current) => current || text);
                }
            })
            .catch((error) => {
                // Expected on iOS/Safari/Firefox/insecure contexts (no permission
                // on open) — the user pastes manually. Logged for triage only.
                console.debug("TtydPasteDialog: clipboard auto-fill on open denied", { error });
            });

        return () => {
            cancelled = true;
        };
    }, [open]);

    const pasteFromClipboard = async () => {
        try {
            // Called synchronously inside this click → a real user gesture on a
            // mounted element, so iOS surfaces its native paste-confirm here.
            const text = await navigator.clipboard?.readText?.();

            if (text) {
                setValue(text);
                textareaRef.current?.focus({ preventScroll: true });
            }
        } catch (error) {
            // Denied/unavailable — the user falls back to long-press → Paste into
            // the box. Logged for triage only.
            console.debug("TtydPasteDialog: clipboard read on button click denied", { error });
        }
    };

    const canReadClipboard = typeof navigator !== "undefined" && Boolean(navigator.clipboard?.readText);

    const submit = () => {
        if (!value) {
            return;
        }

        onSubmit(value);
        onOpenChange(false);
    };

    return (
        <GlassDialogShell open={open} onOpenChange={onOpenChange}>
            <GlassDialogContent
                size="md"
                showCloseButton
                // Top-anchor on mobile so the input sits above the soft keyboard —
                // a vertically-centered dialog forces iOS to scroll/align when the
                // keyboard covers the lower half. Stays centered on desktop (sm+).
                className="top-6 translate-y-0 sm:top-1/2 sm:-translate-y-1/2"
            >
                <GlassDialogBody>
                    <GlassDialogHeader className="space-y-2 text-left">
                        <GlassDialogEyebrow>Paste into terminal</GlassDialogEyebrow>
                        <GlassDialogTitle className="flex items-center gap-2 font-mono text-base">
                            <ClipboardPaste size={16} className="text-emerald-400" />
                            Paste &amp; send
                        </GlassDialogTitle>
                        <GlassDialogDescription className="font-mono text-xs text-zinc-400">
                            Tap Paste from clipboard (Safari shows a confirm), or long-press the box → Paste. Then Send.
                        </GlassDialogDescription>
                    </GlassDialogHeader>

                    <Textarea
                        ref={textareaRef}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => {
                            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                e.preventDefault();
                                submit();
                            }
                        }}
                        placeholder="Paste here…"
                        rows={5}
                        className="resize-none font-mono text-sm"
                    />

                    <GlassDialogFooter className="gap-2 sm:justify-end">
                        {canReadClipboard && (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void pasteFromClipboard()}
                                className="mr-auto gap-2 font-mono text-xs"
                            >
                                <ClipboardPaste size={14} />
                                Paste from clipboard
                            </Button>
                        )}
                        <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            disabled={!value}
                            onClick={submit}
                            className="group rounded-full px-5"
                        >
                            Send
                            <span className="ml-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/20">
                                <CornerDownLeft size={12} />
                            </span>
                        </Button>
                    </GlassDialogFooter>
                </GlassDialogBody>
            </GlassDialogContent>
        </GlassDialogShell>
    );
}
