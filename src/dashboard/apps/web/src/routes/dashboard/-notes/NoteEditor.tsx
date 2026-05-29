import { IconTooltip } from "@ui/components/icon-button";
import { Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { Note } from "@/drizzle";
import { useDeleteNoteMutation, useUpdateNoteMutation } from "@/lib/notes/useNotesQueries";

interface NoteEditorProps {
    note: Note | null;
    userId: string;
}

export function NoteEditor({ note, userId }: NoteEditorProps) {
    const updateMutation = useUpdateNoteMutation();
    const deleteMutation = useDeleteNoteMutation();

    const [localTitle, setLocalTitle] = useState(note?.title ?? "");
    const [localBody, setLocalBody] = useState(note?.body ?? "");
    const [localTags, setLocalTags] = useState((note?.tags ?? []).join(", "));

    // Sync state when selected note changes
    useEffect(() => {
        setLocalTitle(note?.title ?? "");
        setLocalBody(note?.body ?? "");
        setLocalTags((note?.tags ?? []).join(", "));
    }, [note?.id]);

    const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    function handleTitleChange(val: string) {
        setLocalTitle(val);

        if (note) {
            if (titleTimer.current) {
                clearTimeout(titleTimer.current);
            }

            titleTimer.current = setTimeout(() => {
                updateMutation.mutate({ id: note.id, patch: { title: val.trim() || note.title } });
            }, 600);
        }
    }

    const bodyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    function handleBodyChange(val: string) {
        setLocalBody(val);

        if (note) {
            if (bodyTimer.current) {
                clearTimeout(bodyTimer.current);
            }

            bodyTimer.current = setTimeout(() => {
                updateMutation.mutate({ id: note.id, patch: { body: val } });
            }, 1200);
        }
    }

    function handleTagsBlur() {
        if (!note) {
            return;
        }

        const tags = localTags
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);

        updateMutation.mutate({ id: note.id, patch: { tags } });
    }

    function handlePinToggle() {
        if (!note) {
            return;
        }

        updateMutation.mutate({ id: note.id, patch: { pinned: note.pinned === 1 ? 0 : 1 } });
    }

    function handleDelete() {
        if (!note) {
            return;
        }

        if (!confirm(`Delete "${note.title}"?`)) {
            return;
        }

        deleteMutation.mutate({ id: note.id, userId });
    }

    if (!note) {
        return (
            <div className="flex flex-1 items-center justify-center rounded-xl border border-white/5 bg-zinc-900/40">
                <p className="text-sm text-zinc-600" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    Select a note or create a new one.
                </p>
            </div>
        );
    }

    const isPinned = note.pinned === 1;

    return (
        <div className="flex flex-1 flex-col gap-3 min-w-0">
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={localTitle}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    className={[
                        "min-w-0 flex-1 rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-2.5",
                        "text-base font-semibold text-zinc-100 placeholder:text-zinc-600",
                        "focus:outline-none focus:border-emerald-500/40 backdrop-blur-sm transition-colors",
                    ].join(" ")}
                    placeholder="Note title…"
                />

                <input
                    type="text"
                    value={localTags}
                    onChange={(e) => setLocalTags(e.target.value)}
                    onBlur={handleTagsBlur}
                    placeholder="tags, comma, separated"
                    className={[
                        "w-52 shrink-0 rounded-xl border border-white/10 bg-zinc-900/60 px-3 py-2.5",
                        "text-[11px] text-zinc-400 placeholder:text-zinc-600",
                        "focus:outline-none focus:border-emerald-500/40 backdrop-blur-sm transition-colors",
                    ].join(" ")}
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                />

                <IconTooltip tooltip={isPinned ? "Unpin" : "Pin to top"}>
                    <button
                        type="button"
                        onClick={handlePinToggle}
                        className={[
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-all hover:-translate-y-0.5",
                            isPinned
                                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                                : "border-white/10 bg-zinc-900/60 text-zinc-500 hover:border-emerald-500/20 hover:text-emerald-400",
                        ].join(" ")}
                    >
                        {isPinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
                    </button>
                </IconTooltip>

                <IconTooltip tooltip="Delete note">
                    <button
                        type="button"
                        onClick={handleDelete}
                        disabled={deleteMutation.isPending}
                        className={[
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10",
                            "bg-zinc-900/60 text-zinc-500 transition-all hover:-translate-y-0.5",
                            "hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400",
                            "disabled:opacity-40",
                        ].join(" ")}
                    >
                        <Trash2 className="h-4 w-4" />
                    </button>
                </IconTooltip>
            </div>

            <div className="flex flex-1 gap-3 min-h-0">
                <div className="flex flex-1 flex-col min-w-0">
                    <p
                        className="mb-1 text-[10px] text-zinc-600 uppercase tracking-wider"
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                        Markdown
                    </p>
                    <textarea
                        value={localBody}
                        onChange={(e) => handleBodyChange(e.target.value)}
                        spellCheck={false}
                        className={[
                            "flex-1 resize-none rounded-xl border border-white/10 bg-zinc-900/60",
                            "p-4 text-sm text-zinc-200 placeholder:text-zinc-600",
                            "focus:outline-none focus:border-emerald-500/30 backdrop-blur-sm",
                            "font-mono leading-relaxed",
                        ].join(" ")}
                        style={{ fontFamily: "'JetBrains Mono', monospace", minHeight: "calc(100vh - 340px)" }}
                        placeholder={"# Title\n\nStart writing in markdown…"}
                    />
                </div>

                <div className="flex flex-1 flex-col min-w-0">
                    <p
                        className="mb-1 text-[10px] text-zinc-600 uppercase tracking-wider"
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                        Preview
                    </p>
                    <div
                        className={[
                            "flex-1 overflow-auto rounded-xl border border-white/5 bg-zinc-900/40",
                            "p-4 text-sm text-zinc-300 backdrop-blur-sm",
                            "prose prose-invert prose-sm max-w-none",
                        ].join(" ")}
                        style={{ minHeight: "calc(100vh - 340px)" }}
                    >
                        {localBody ? (
                            <Streamdown mode="static">{localBody}</Streamdown>
                        ) : (
                            <p className="text-zinc-600" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                                Preview will appear here.
                            </p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
