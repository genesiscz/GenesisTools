import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { AnimatedCard, EmptyState, FloatingActionButton, PageLoadingSpinner } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Bookmark, Plus } from "lucide-react";
import { useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { bookmarkKeys } from "@/lib/bookmarks/bookmarks-keys";
import { useBookmarks } from "@/lib/bookmarks/hooks/useBookmarks";
import { useServerEvents } from "@/lib/events/useServerEvents";
import { BookmarkCard, BookmarkFilters, BookmarkForm } from "./-bookmarks";

export const Route = createFileRoute("/dashboard/bookmarks")({
    component: BookmarksPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

/** Dev fallback userId when no WorkOS session is present. */
const DEV_USER_ID = "dev-user";

function BookmarksPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const queryClient = useQueryClient();

    // Cross-tab/device sync via the shared SSE event bus
    useServerEvents({
        userId,
        domain: "bookmarks",
        onEvent: () => queryClient.invalidateQueries({ queryKey: bookmarkKeys.all }),
    });

    const { bookmarks, loading, initialized, addBookmark, removeBookmark, getAllTags } = useBookmarks(userId);

    const [formOpen, setFormOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [activeTag, setActiveTag] = useState<string | null>(null);

    // Client-side filter (fast, no server round-trip)
    const filtered = bookmarks.filter((bm) => {
        const matchesTag = activeTag === null || bm.tags.includes(activeTag);
        const needle = search.toLowerCase();
        const matchesSearch =
            !needle ||
            bm.title.toLowerCase().includes(needle) ||
            bm.url.toLowerCase().includes(needle) ||
            bm.description.toLowerCase().includes(needle) ||
            bm.tags.some((t) => t.includes(needle));
        return matchesTag && matchesSearch;
    });

    if (authLoading || (!initialized && loading)) {
        return (
            <DashboardLayout title="Bookmarks" description="Save and organize links">
                <PageLoadingSpinner label="Loading bookmarks…" />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout title="Bookmarks" description="Save and organize links with metadata and tags">
            <div className="flex flex-col gap-6">
                {/* Filters row — only shown when there's content to filter */}
                {bookmarks.length > 0 && (
                    <BookmarkFilters
                        search={search}
                        onSearchChange={setSearch}
                        activeTag={activeTag}
                        onTagChange={setActiveTag}
                        allTags={getAllTags()}
                    />
                )}

                {/* Empty state */}
                {bookmarks.length === 0 ? (
                    <EmptyState
                        icon={Bookmark}
                        title="No bookmarks yet"
                        description="Save URLs with auto-filled titles, descriptions, and tags. Find anything instantly with search."
                        cta={
                            <Button
                                onClick={() => setFormOpen(true)}
                                size="lg"
                                className="bg-rose-500 hover:bg-rose-600 text-white gap-2 mt-2"
                            >
                                <Plus className="h-5 w-5" />
                                Save your first bookmark
                            </Button>
                        }
                    />
                ) : filtered.length === 0 ? (
                    <EmptyState
                        icon={Bookmark}
                        title="No matches"
                        description="Try adjusting your search or tag filter."
                        iconSize="md"
                        rings={false}
                    />
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {filtered.map((bm, i) => (
                            <AnimatedCard key={bm.id} index={i} stagger={40}>
                                <BookmarkCard bookmark={bm} onDelete={removeBookmark} className="h-full" />
                            </AnimatedCard>
                        ))}
                    </div>
                )}

                {/* Stat footer */}
                {bookmarks.length > 0 && (
                    <p className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground/40 text-center">
                        {filtered.length} of {bookmarks.length} bookmark{bookmarks.length !== 1 ? "s" : ""}
                        {activeTag ? ` · tag: ${activeTag}` : ""}
                        {search ? ` · search: "${search}"` : ""}
                    </p>
                )}
            </div>

            {/* Floating add button — only when list is non-empty */}
            {bookmarks.length > 0 && (
                <FloatingActionButton icon={Plus} onClick={() => setFormOpen(true)} label="Save bookmark" />
            )}

            {/* Add bookmark form */}
            <BookmarkForm
                open={formOpen}
                onOpenChange={setFormOpen}
                onSubmit={async (input) => {
                    await addBookmark(input);
                }}
                existingTags={getAllTags()}
            />
        </DashboardLayout>
    );
}
