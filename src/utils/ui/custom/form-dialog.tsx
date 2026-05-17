import { Button } from "@ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib/utils";
import type React from "react";

interface FormDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    children: React.ReactNode;
    onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
    submitLabel: React.ReactNode;
    cancelLabel?: React.ReactNode;
    isSubmitting?: boolean;
    submitDisabled?: boolean;
    maxWidth?: string;
    footer?: React.ReactNode;
}

export function FormDialog({
    open,
    onOpenChange,
    title,
    description,
    children,
    onSubmit,
    submitLabel,
    cancelLabel = "Cancel",
    isSubmitting,
    submitDisabled,
    maxWidth,
    footer,
}: FormDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn("border-purple-500/30 bg-black/95 backdrop-blur-xl", maxWidth)}
                aria-describedby={description ? undefined : undefined}
            >
                <form onSubmit={onSubmit} className="space-y-6">
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        {description && <DialogDescription>{description}</DialogDescription>}
                    </DialogHeader>

                    {children}

                    <DialogFooter>
                        {footer ?? (
                            <>
                                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                                    {cancelLabel}
                                </Button>
                                <Button type="submit" variant="brand" disabled={isSubmitting || submitDisabled}>
                                    {submitLabel}
                                </Button>
                            </>
                        )}
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
