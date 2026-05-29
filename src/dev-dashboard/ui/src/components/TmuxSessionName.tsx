import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Check, Pencil, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { tmuxApi } from "@/lib/api";

const pillClass =
    "inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--dd-accent-from)]/15 px-2.5 py-0.5 font-mono text-[var(--dd-accent-from)] ring-1 ring-[var(--dd-accent-from)]/40";

interface Props {
    name: string;
    editable?: boolean;
    size?: "sm" | "md";
    className?: string;
    onRenamed?: (nextName: string) => void;
}

export function TmuxSessionName({ name, editable = true, size = "sm", className = "", onRenamed }: Props) {
    const [currentName, setCurrentName] = useState(name);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(name);

    useEffect(() => {
        setCurrentName(name);
    }, [name]);

    useEffect(() => {
        if (!editing) {
            setDraft(currentName);
        }
    }, [editing, currentName]);

    const rename = useMutation({
        mutationFn: (body: { from: string; to: string }) => tmuxApi.rename(body).then((r) => r.sessionName),
        onSuccess: (nextName) => {
            setCurrentName(nextName);
            setDraft(nextName);
            setEditing(false);
            onRenamed?.(nextName);
        },
    });

    const submitRename = () => {
        const nextName = draft.trim();

        if (rename.isPending || nextName.length === 0) {
            return;
        }

        rename.mutate({ from: currentName, to: nextName });
    };

    const textSize = size === "md" ? "text-sm" : "text-xs";

    if (!editable) {
        return (
            <span className={`${pillClass} ${textSize} ${className}`}>
                <span className="truncate">{currentName}</span>
            </span>
        );
    }

    if (editing) {
        return (
            <div className={`flex min-w-0 flex-wrap items-center gap-1.5 ${className}`}>
                <Input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            submitRename();
                        }

                        if (event.key === "Escape") {
                            event.preventDefault();
                            setDraft(currentName);
                            setEditing(false);
                        }
                    }}
                    className={`h-7 min-w-[8rem] flex-1 font-mono ${textSize} border-[var(--dd-accent-from)]/30 bg-black/40`}
                    autoFocus
                />
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={rename.isPending || draft.trim().length === 0}
                    onClick={submitRename}
                    className="text-emerald-400 hover:bg-emerald-400/10 hover:text-emerald-300"
                    aria-label="Confirm rename"
                >
                    <Check size={14} />
                </Button>
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={rename.isPending}
                    onClick={() => {
                        setDraft(currentName);
                        setEditing(false);
                    }}
                    className="text-rose-400 hover:bg-rose-400/10 hover:text-rose-300"
                    aria-label="Cancel rename"
                >
                    <X size={14} />
                </Button>
            </div>
        );
    }

    return (
        <span className={`group inline-flex min-w-0 max-w-full items-center gap-1 ${className}`}>
            <button
                type="button"
                onClick={() => {
                    setDraft(currentName);
                    setEditing(true);
                }}
                className={`${pillClass} ${textSize} transition-colors hover:bg-[var(--dd-accent-from)]/20`}
            >
                <span className="truncate">{currentName}</span>
            </button>
            <button
                type="button"
                onClick={() => {
                    setDraft(currentName);
                    setEditing(true);
                }}
                className="shrink-0 rounded-md p-1 text-[var(--dd-text-muted)] transition-colors hover:bg-white/5 hover:text-[var(--dd-accent-from)]"
                aria-label="Rename tmux session"
            >
                <Pencil size={12} />
            </button>
            {rename.isError ? (
                <span className="font-mono text-[10px] text-rose-400">
                    {rename.error instanceof Error ? rename.error.message : String(rename.error)}
                </span>
            ) : null}
        </span>
    );
}

export function TmuxSessionNameLabel({ children }: { children: ReactNode }) {
    return <span className="text-[var(--dd-text-secondary)]">{children}</span>;
}
