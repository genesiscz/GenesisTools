import { Button } from "@app/utils/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@app/utils/ui/components/dialog";
import { Input } from "@app/utils/ui/components/input";
import { useState } from "react";

interface Props {
    open: boolean;
    onClose: () => void;
    onSubmit: (creds: { cookie: string }) => Promise<void>;
}

export function ConnectKosikDialog({ open, onClose, onSubmit }: Props) {
    const [cookie, setCookie] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handle() {
        setSubmitting(true);
        setError(null);
        try {
            await onSubmit({ cookie });
            onClose();
            setCookie("");
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
                    <DialogTitle>Connect Košík.cz</DialogTitle>
                </DialogHeader>
                <ol className="text-xs font-mono text-muted-foreground space-y-2 py-2 list-decimal pl-4">
                    <li>
                        Open{" "}
                        <a
                            className="underline text-foreground"
                            href="https://www.kosik.cz"
                            target="_blank"
                            rel="noreferrer"
                        >
                            kosik.cz
                        </a>{" "}
                        in a new tab and log in normally.
                    </li>
                    <li>
                        Open DevTools (⌘⌥I or F12) → Application → Cookies → www.kosik.cz → copy the value of the{" "}
                        <code className="text-foreground">sid</code> cookie.
                    </li>
                    <li>Paste it below.</li>
                </ol>
                <Input
                    placeholder="sid value (or full sid=… string)"
                    value={cookie}
                    onChange={(e) => setCookie(e.target.value)}
                />
                {error ? <div className="text-xs text-[var(--color-neon-coral)] pt-2">{error}</div> : null}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={handle} disabled={submitting || cookie.length === 0}>
                        {submitting ? "Validating…" : "Connect"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
