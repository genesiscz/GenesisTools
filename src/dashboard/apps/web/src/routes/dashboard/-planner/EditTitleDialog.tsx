import { Button } from "@ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { useEffect, useState } from "react";

interface EditTitleDialogProps {
    open: boolean;
    initialTitle: string;
    onOpenChange: (open: boolean) => void;
    onSave: (title: string) => Promise<void>;
}

export function EditTitleDialog({ open, initialTitle, onOpenChange, onSave }: EditTitleDialogProps) {
    const [title, setTitle] = useState(initialTitle);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open) {
            setTitle(initialTitle);
        }
    }, [open, initialTitle]);

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const trimmed = title.trim();

        if (!trimmed) {
            return;
        }

        setSaving(true);
        try {
            await onSave(trimmed);
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[420px]" data-testid="planner-edit-title-dialog">
                <DialogHeader>
                    <DialogTitle>Edit task title</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <Input
                        data-testid="planner-edit-title-input"
                        value={title}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
                        placeholder="Task title"
                        autoFocus
                    />
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            variant="brand"
                            disabled={saving || !title.trim()}
                            data-testid="planner-edit-title-save"
                        >
                            {saving ? "Saving…" : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
