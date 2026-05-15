import { FormDialog, FormField } from "@ui/custom";
import type React from "react";
import { useState } from "react";
import { useCreateNoteMutation } from "@/lib/notes/useNotesQueries";

interface CreateNoteDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    userId: string;
    onCreated: (noteId: string) => void;
}

export function CreateNoteDialog({ open, onOpenChange, userId, onCreated }: CreateNoteDialogProps) {
    const [title, setTitle] = useState("");
    const [tagsInput, setTagsInput] = useState("");
    const createMutation = useCreateNoteMutation();

    function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();

        const trimmedTitle = title.trim();

        if (!trimmedTitle) {
            return;
        }

        const tags = tagsInput
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);

        createMutation.mutate(
            { userId, title: trimmedTitle, body: "", tags, pinned: 0 },
            {
                onSuccess: (note) => {
                    setTitle("");
                    setTagsInput("");
                    onCreated(note.id);
                },
            }
        );
    }

    return (
        <FormDialog
            open={open}
            onOpenChange={(v) => {
                if (!v) {
                    setTitle("");
                    setTagsInput("");
                }

                onOpenChange(v);
            }}
            title="New note"
            description="Enter a title to create the note. Add tags separated by commas."
            onSubmit={handleSubmit}
            submitLabel={createMutation.isPending ? "Creating…" : "Create"}
            isSubmitting={createMutation.isPending}
            submitDisabled={!title.trim()}
        >
            <div className="flex flex-col gap-4">
                <FormField label="Title" required>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Note title…"
                        // biome-ignore lint/a11y/noAutofocus: dialog title field is the primary action target
                        autoFocus
                        className={[
                            "w-full rounded-lg border border-white/10 bg-zinc-900/80 px-3 py-2",
                            "text-sm text-zinc-100 placeholder:text-zinc-600",
                            "focus:outline-none focus:border-emerald-500/40",
                        ].join(" ")}
                    />
                </FormField>

                <FormField label="Tags (comma-separated)">
                    <input
                        type="text"
                        value={tagsInput}
                        onChange={(e) => setTagsInput(e.target.value)}
                        placeholder="work, ideas, project-x"
                        className={[
                            "w-full rounded-lg border border-white/10 bg-zinc-900/80 px-3 py-2",
                            "text-sm text-zinc-100 placeholder:text-zinc-600",
                            "focus:outline-none focus:border-emerald-500/40",
                            "font-mono",
                        ].join(" ")}
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    />
                </FormField>
            </div>
        </FormDialog>
    );
}
