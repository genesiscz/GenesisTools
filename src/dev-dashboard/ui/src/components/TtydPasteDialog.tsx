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
 * Fallback paste path for browsers where `navigator.clipboard.readText()` is
 * denied (iOS / macOS Safari, Firefox). The user pastes into a real focusable
 * textarea via the native OS paste — which needs no clipboard permission — then
 * Sends, and we inject the value with the same `term.paste()` bridge the
 * one-tap path uses. Multi-line is preserved; ⌘/Ctrl+Enter sends.
 */
export function TtydPasteDialog({ open, onOpenChange, onSubmit }: Props) {
    const [value, setValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        if (!open) {
            setValue("");
            return;
        }

        // Best-effort focus so the soft keyboard rises; on iOS the user may need
        // one tap if the activation gesture was already consumed upstream.
        const id = window.setTimeout(() => textareaRef.current?.focus(), 50);

        return () => window.clearTimeout(id);
    }, [open]);

    const submit = () => {
        if (!value) {
            return;
        }

        onSubmit(value);
        onOpenChange(false);
    };

    return (
        <GlassDialogShell open={open} onOpenChange={onOpenChange}>
            <GlassDialogContent size="md" showCloseButton>
                <GlassDialogBody>
                    <GlassDialogHeader className="space-y-2 text-left">
                        <GlassDialogEyebrow>Paste into terminal</GlassDialogEyebrow>
                        <GlassDialogTitle className="flex items-center gap-2 font-mono text-base">
                            <ClipboardPaste size={16} className="text-emerald-400" />
                            Paste &amp; send
                        </GlassDialogTitle>
                        <GlassDialogDescription className="font-mono text-xs text-zinc-400">
                            Long-press → Paste (or ⌘V) into the box, then Send. Works where the one-tap paste can&apos;t
                            (Safari / Firefox).
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
                        autoFocus
                        rows={5}
                        className="resize-none font-mono text-sm"
                    />

                    <GlassDialogFooter className="gap-2 sm:justify-end">
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
