import { AuthForm } from "@app/youtube/ui/components/shared/auth-form";
import { useLogin, useRegister } from "@app/yt/api.hooks";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@genesiscz/utils/ui/components/dialog";

export function AuthDialog({
    open,
    onOpenChange,
    initialMode = "login",
    onSuccess,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialMode?: "login" | "register";
    onSuccess?: () => void;
}) {
    const login = useLogin();
    const register = useRegister();
    const busy = login.isPending || register.isPending;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="yt-panel max-w-sm border-primary/25" onOpenAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader>
                    <DialogTitle className="gradient-text text-xl">Account</DialogTitle>
                    <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
                        Sign in to spend diamonds on summaries and questions. New accounts start with 💎 100.
                    </DialogDescription>
                </DialogHeader>
                <AuthForm
                    key={initialMode}
                    idPrefix="yt-ui-auth-dialog"
                    initialMode={initialMode}
                    busy={busy}
                    onLogin={(creds) => login.mutateAsync(creds).then(() => undefined)}
                    onRegister={(creds) => register.mutateAsync(creds).then(() => undefined)}
                    onSuccess={onSuccess}
                />
            </DialogContent>
        </Dialog>
    );
}
