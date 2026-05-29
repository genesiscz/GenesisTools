import { Button } from "@ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@ui/components/dialog";

interface Props {
    open: boolean;
    todoTitle: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    pending?: boolean;
}

export function TodoDeleteDialog({ open, todoTitle, onOpenChange, onConfirm, pending }: Props) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="dd-panel max-w-md border-white/10 bg-[#050505]/95">
                <DialogHeader>
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--dd-text-muted)]">
                        Remove todo
                    </p>
                    <DialogTitle className="font-mono text-base">Delete reminder?</DialogTitle>
                    <DialogDescription className="font-mono text-xs text-[var(--dd-text-secondary)]">
                        {todoTitle}
                    </DialogDescription>
                </DialogHeader>
                <p className="font-mono text-[11px] leading-relaxed text-[var(--dd-text-muted)]">
                    This removes the reminder from Apple Reminders. It cannot be undone from here.
                </p>
                <DialogFooter className="flex-col gap-2 sm:flex-col">
                    <Button
                        type="button"
                        variant="destructive"
                        disabled={pending}
                        onClick={onConfirm}
                        className="w-full font-mono text-xs"
                    >
                        Delete reminder
                    </Button>
                    <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
