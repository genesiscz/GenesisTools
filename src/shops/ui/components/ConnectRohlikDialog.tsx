import { Button } from "@app/utils/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@app/utils/ui/components/dialog";
import { Input } from "@app/utils/ui/components/input";
import { useState } from "react";

interface Props {
    open: boolean;
    onClose: () => void;
    onSubmit: (creds: { email: string; password: string }) => Promise<void>;
}

export function ConnectRohlikDialog({ open, onClose, onSubmit }: Props) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handle() {
        setSubmitting(true);
        setError(null);
        try {
            await onSubmit({ email, password });
            onClose();
            setEmail("");
            setPassword("");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Connect Rohlík.cz</DialogTitle>
                </DialogHeader>
                <div className="space-y-3 py-2">
                    <Input
                        type="email"
                        placeholder="Email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="email"
                    />
                    <Input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                    />
                    {error ? <div className="text-xs text-[var(--color-neon-coral)]">{error}</div> : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={handle} disabled={submitting || !email || !password}>
                        {submitting ? "Connecting…" : "Connect"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
