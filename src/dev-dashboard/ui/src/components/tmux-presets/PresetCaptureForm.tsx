import { Button } from "@ui/components/button";
import { type FormEvent, useState } from "react";

interface PresetCaptureFormProps {
    onCapture: (input: { name: string; note?: string }) => void;
    pending: boolean;
}

/**
 * Inline "capture current layout" form for the web dashboard. A name input + optional note input +
 * submit, mirroring the todos `AddTodoForm` look (bordered panel inputs + a `dd-btn-accent` ghost
 * Button). On submit it calls `onCapture` and clears; submit is disabled while the name is empty or a
 * capture is in flight.
 */
export function PresetCaptureForm({ onCapture, pending }: PresetCaptureFormProps) {
    const [name, setName] = useState("");
    const [note, setNote] = useState("");

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        const trimmed = name.trim();

        if (!trimmed || pending) {
            return;
        }

        onCapture({ name: trimmed, note: note.trim() || undefined });
        setName("");
        setNote("");
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
            <input
                type="text"
                aria-label="Preset name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Preset name..."
                className="min-w-[12rem] flex-1 rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
            />
            <input
                type="text"
                aria-label="Preset note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (optional)..."
                className="min-w-[12rem] flex-1 rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-secondary)] outline-none focus:border-[var(--dd-accent-from)]"
            />
            <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={pending || !name.trim()}
                className="dd-btn-accent shrink-0 hover:bg-transparent"
            >
                {pending ? "Capturing..." : "Capture current layout"}
            </Button>
        </form>
    );
}
