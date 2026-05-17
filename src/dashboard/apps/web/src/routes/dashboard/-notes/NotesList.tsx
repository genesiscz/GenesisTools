import { Pin, PlusCircle } from "lucide-react";
import type { Note } from "@/drizzle";

const PINNED_BORDER: Record<string, string> = {
    yes: "border-l-emerald-500",
    no: "border-l-white/5",
};

interface NotesListProps {
    notes: Note[];
    selectedNoteId: string | null;
    onSelect: (id: string) => void;
    onCreateClick: () => void;
    userId: string;
}

export function NotesList({ notes, selectedNoteId, onSelect, onCreateClick }: NotesListProps) {
    return (
        <div className="flex w-72 shrink-0 flex-col gap-2">
            <button
                type="button"
                onClick={onCreateClick}
                className={[
                    "flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5",
                    "px-4 py-2.5 text-sm font-medium text-emerald-400",
                    "transition-all hover:-translate-y-0.5 hover:border-emerald-500/40 hover:bg-emerald-500/10",
                ].join(" ")}
            >
                <PlusCircle className="h-4 w-4" />
                New note
            </button>

            {notes.length === 0 && (
                <p
                    className="py-12 text-center text-sm text-zinc-600"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                    No notes yet.
                </p>
            )}

            {notes.map((note) => {
                const isActive = note.id === selectedNoteId;
                const pinnedKey = note.pinned === 1 ? "yes" : "no";
                const borderCls = PINNED_BORDER[pinnedKey] ?? PINNED_BORDER.no;

                return (
                    <button
                        key={note.id}
                        type="button"
                        onClick={() => onSelect(note.id)}
                        className={[
                            "group flex flex-col items-start gap-1 rounded-xl border-l-2 border-white/5 px-4 py-3 text-left",
                            "backdrop-blur-sm transition-all hover:-translate-y-0.5",
                            borderCls,
                            isActive
                                ? "bg-emerald-500/10 border-emerald-500/30"
                                : "bg-zinc-900/60 hover:bg-zinc-900/80",
                        ].join(" ")}
                    >
                        <div className="flex w-full items-center gap-1.5 min-w-0">
                            {note.pinned === 1 && <Pin className="h-3 w-3 shrink-0 text-emerald-400" />}
                            <span className="truncate text-sm font-medium text-zinc-100">{note.title}</span>
                        </div>

                        {note.body && (
                            <span className="line-clamp-2 text-[11px] text-zinc-500">
                                {note.body.replace(/[#*`_~[\]]/g, "").substring(0, 80)}
                            </span>
                        )}

                        {(note.tags ?? []).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                                {(note.tags ?? []).map((tag) => (
                                    <span
                                        key={tag}
                                        className="rounded px-1.5 py-0.5 text-[10px] bg-zinc-800 text-zinc-400"
                                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                                    >
                                        #{tag}
                                    </span>
                                ))}
                            </div>
                        )}

                        <span
                            className="text-[10px] text-zinc-600"
                            style={{ fontFamily: "'JetBrains Mono', monospace" }}
                        >
                            {new Date(note.updatedAt).toLocaleDateString([], {
                                month: "short",
                                day: "numeric",
                            })}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
