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
    sessionLabel: string;
    onOpenChange: (open: boolean) => void;
    onKeep: () => void;
    onKill: () => void;
    pending?: boolean;
}

export function TtydCloseDialog({ open, sessionLabel, onOpenChange, onKeep, onKill, pending }: Props) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="dd-panel max-w-md border-white/10 bg-[#050505]/95">
                <DialogHeader>
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--dd-text-muted)]">
                        Close terminal
                    </p>
                    <DialogTitle className="font-mono text-base">Close web terminal?</DialogTitle>
                    <DialogDescription className="font-mono text-xs text-[var(--dd-text-secondary)]">
                        {sessionLabel}
                    </DialogDescription>
                </DialogHeader>
                <p className="font-mono text-[11px] leading-relaxed text-[var(--dd-text-muted)]">
                    The ttyd web tab will close. Choose whether to keep the underlying tmux session for cmux handoff or
                    destroy it.
                </p>
                <DialogFooter className="flex-col gap-2 sm:flex-col">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        onClick={onKeep}
                        className="w-full font-mono text-xs"
                    >
                        Close tab, keep tmux session
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        disabled={pending}
                        onClick={onKill}
                        className="w-full font-mono text-xs"
                    >
                        Close tab and kill tmux session
                    </Button>
                    <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
