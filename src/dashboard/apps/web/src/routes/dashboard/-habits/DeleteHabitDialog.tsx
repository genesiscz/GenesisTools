import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@ui/components/alert-dialog";

interface DeleteHabitDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    habitName: string;
    onConfirm: () => void;
}

export function DeleteHabitDialog({ open, onOpenChange, habitName, onConfirm }: DeleteHabitDialogProps) {
    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent className="border-rose-500/30 bg-black/95 backdrop-blur-xl">
                <AlertDialogHeader>
                    <AlertDialogTitle>Archive “{habitName}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                        This removes the habit from your list. Its history is kept, but the heatmap and streak will no
                        longer be shown.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        data-testid="habit-archive-confirm"
                        onClick={onConfirm}
                        className="bg-rose-500 text-white hover:bg-rose-600"
                    >
                        Archive habit
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
