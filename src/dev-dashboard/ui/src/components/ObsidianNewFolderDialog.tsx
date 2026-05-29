import { SafeJSON } from "@app/utils/json";
import { Button } from "@ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { FolderPlus } from "lucide-react";
import { useEffect, useId, useState } from "react";

function parentLabel(parent: string): string {
    if (!parent) {
        return "Vault root";
    }

    return parent;
}

function validateFolderName(name: string): string | null {
    const trimmed = name.trim();

    if (!trimmed) {
        return "Enter a folder name.";
    }

    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
        return "Name cannot contain /, \\, or ..";
    }

    return null;
}

export function ObsidianNewFolderDialog({
    open,
    onOpenChange,
    parentDir,
    onCreated,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    parentDir: string;
    onCreated: (relativeDir: string) => void;
}) {
    const inputId = useId();
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    useEffect(() => {
        if (!open) {
            return;
        }

        setName("");
        setError(null);
        setPending(false);
    }, [open]);

    const submit = async (): Promise<void> => {
        const validation = validateFolderName(name);

        if (validation) {
            setError(validation);
            return;
        }

        const trimmed = name.trim();
        const relativeDir = parentDir ? `${parentDir}/${trimmed}` : trimmed;

        setPending(true);
        setError(null);

        try {
            const res = await fetch("/api/obsidian/mkdir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ relativeDir }),
            });

            if (!res.ok) {
                const err = (await res.json().catch(() => ({ error: "Unknown error" }))) as { error?: string };
                setError(err.error ?? "Could not create folder");
                return;
            }

            onCreated(relativeDir);
            onOpenChange(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="dd-panel max-w-md gap-4 border-[var(--dd-border)] bg-[var(--dd-bg-panel)]/95 sm:max-w-md">
                <DialogHeader className="space-y-2 text-left">
                    <div className="flex items-center gap-2">
                        <span className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--dd-border)] bg-black/25 text-[var(--dd-accent-from)]">
                            <FolderPlus className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--dd-text-muted)]">
                                Obsidian vault
                            </p>
                            <DialogTitle className="text-base text-[var(--dd-text-primary)]">New folder</DialogTitle>
                        </div>
                    </div>
                    <DialogDescription className="text-left text-xs text-[var(--dd-text-secondary)]">
                        Creates{" "}
                        <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px] text-[var(--dd-text-primary)]">
                            {parentDir ? `${parentDir}/` : ""}
                            <span className="text-[var(--dd-accent-from)]">{name.trim() || "…"}</span>
                        </code>{" "}
                        inside <span className="font-mono text-[var(--dd-text-primary)]">{parentLabel(parentDir)}</span>
                        .
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-2">
                    <Label htmlFor={inputId} className="text-xs uppercase tracking-wider text-[var(--dd-text-muted)]">
                        Folder name
                    </Label>
                    <Input
                        id={inputId}
                        value={name}
                        autoFocus
                        disabled={pending}
                        placeholder="e.g. qa-notes"
                        className="border-[var(--dd-border)] bg-black/20 font-mono text-sm"
                        onChange={(event) => {
                            setName(event.target.value);
                            setError(null);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                void submit();
                            }
                        }}
                    />
                    {error ? <p className="text-xs text-[var(--dd-danger)]">{error}</p> : null}
                </div>

                <DialogFooter className="gap-2 sm:justify-end">
                    <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button type="button" disabled={pending || !name.trim()} onClick={() => void submit()}>
                        {pending ? "Creating…" : "Create folder"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
