import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { useServerEvents } from "@/lib/events/useServerEvents";
import { notesKeys } from "@/lib/notes/notes-keys";
import { useNotesQuery } from "@/lib/notes/useNotesQueries";
import { CreateNoteDialog } from "./-notes/CreateNoteDialog";
import { NoteEditor } from "./-notes/NoteEditor";
import { NotesList } from "./-notes/NotesList";
import { NoteTagFilter } from "./-notes/NoteTagFilter";
import { useNotesState } from "./-notes/useNotesState";

export const Route = createFileRoute("/dashboard/notes")({
    component: QuickNotesPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

/** Dev fallback userId when no WorkOS session is present. */
const DEV_USER_ID = "dev-user";

function QuickNotesPage() {
    return (
        <DashboardLayout title="Quick Notes" description="Capture thoughts instantly with markdown support and tagging">
            <NotesRoot />
        </DashboardLayout>
    );
}

function NotesRoot() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);

    useServerEvents({
        userId,
        domain: "notes",
        onEvent: () => queryClient.invalidateQueries({ queryKey: notesKeys.all }),
    });

    const notesQuery = useNotesQuery(userId);
    const state = useNotesState();

    const allNotes = notesQuery.data ?? [];

    const allTags = Array.from(new Set(allNotes.flatMap((n) => n.tags ?? []))).sort();

    const filteredNotes = allNotes.filter((n) => {
        const matchesTag = state.activeTag === null || (n.tags ?? []).includes(state.activeTag);
        const q = state.searchQuery.toLowerCase().trim();
        const matchesSearch = q === "" || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
        return matchesTag && matchesSearch;
    });

    const selectedNote = filteredNotes.find((n) => n.id === state.selectedNoteId) ?? null;

    if (notesQuery.isLoading) {
        return (
            <div className="flex h-64 items-center justify-center">
                <p className="text-sm text-zinc-500" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    Loading notes…
                </p>
            </div>
        );
    }

    if (notesQuery.error) {
        return (
            <div className="flex h-64 items-center justify-center">
                <p className="text-sm text-red-400">Failed to load notes.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="relative">
                <input
                    type="text"
                    value={state.searchQuery}
                    onChange={(e) => state.setSearchQuery(e.target.value)}
                    placeholder="Search notes…"
                    className={[
                        "w-full rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-2.5 text-sm text-zinc-100",
                        "placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/40",
                        "backdrop-blur-sm transition-colors",
                    ].join(" ")}
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                />
            </div>

            {allTags.length > 0 && (
                <NoteTagFilter tags={allTags} activeTag={state.activeTag} onToggle={state.toggleTag} />
            )}

            <div className="flex gap-3" style={{ minHeight: "calc(100vh - 280px)" }}>
                <NotesList
                    notes={filteredNotes}
                    selectedNoteId={state.selectedNoteId}
                    onSelect={state.selectNote}
                    onCreateClick={() => state.setCreateDialogOpen(true)}
                    userId={userId ?? ""}
                />
                <NoteEditor note={selectedNote} userId={userId ?? ""} />
            </div>

            <CreateNoteDialog
                open={state.createDialogOpen}
                onOpenChange={state.setCreateDialogOpen}
                userId={userId ?? ""}
                onCreated={(id) => {
                    state.setCreateDialogOpen(false);
                    state.selectNote(id);
                }}
            />
        </div>
    );
}
