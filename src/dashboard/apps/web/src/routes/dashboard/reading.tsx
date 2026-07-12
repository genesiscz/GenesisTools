import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { AnimatedCard, EmptyState, FloatingActionButton, PageLoadingSpinner, StatTile } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { BookMarked, BookOpen, CheckCircle2, Library, Plus } from "lucide-react";
import { useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { useServerEvents } from "@/lib/events/useServerEvents";
import type { ReadingStatus } from "@/lib/reading/hooks/useReading";
import { useReading } from "@/lib/reading/hooks/useReading";
import type { ReadingItemRow } from "@/lib/reading/reading.server";
import { READING_SYNC_CHANNEL, readingKeys } from "@/lib/reading/reading-keys";
import { useBroadcastInvalidation } from "@/lib/sync/useBroadcastInvalidation";
import { ReadingCard, ReadingDetailDialog, ReadingForm } from "./-reading";

export const Route = createFileRoute("/dashboard/reading")({
    component: ReadingPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

const DEV_USER_ID = "dev-user";

const COLUMNS: { status: ReadingStatus; label: string; icon: typeof BookMarked; testId: string }[] = [
    { status: "to_read", label: "To Read", icon: BookMarked, testId: "reading-column-to_read" },
    { status: "reading", label: "Reading", icon: BookOpen, testId: "reading-column-reading" },
    { status: "done", label: "Done", icon: CheckCircle2, testId: "reading-column-done" },
];

function ReadingPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const queryClient = useQueryClient();

    // Cross-tab sync (criterion #6) — listen for sibling-tab invalidations.
    useBroadcastInvalidation(READING_SYNC_CHANNEL);

    // Cross-device sync via the shared SSE event bus.
    useServerEvents({
        userId,
        domain: "reading",
        onEvent: () => queryClient.invalidateQueries({ queryKey: readingKeys.all }),
    });

    const { items, loading, initialized, addItem, setStatus, setCurrentPage, setRating, removeItem, getAllTags } =
        useReading(userId);

    const [formOpen, setFormOpen] = useState(false);
    const [detailItem, setDetailItem] = useState<ReadingItemRow | null>(null);

    const grouped: Record<ReadingStatus, ReadingItemRow[]> = {
        to_read: [],
        reading: [],
        done: [],
    };
    for (const item of items) {
        grouped[item.status].push(item);
    }

    if (authLoading || (!initialized && loading)) {
        return (
            <DashboardLayout title="Reading List" description="Your books, articles, progress and highlights">
                <PageLoadingSpinner label="Loading your shelf…" />
            </DashboardLayout>
        );
    }

    if (items.length === 0) {
        return (
            <DashboardLayout title="Reading List" description="Your books, articles, progress and highlights">
                <div data-testid="reading-empty">
                    <EmptyState
                        icon={Library}
                        title="Your shelf is empty"
                        description="Add books, articles, and papers. Track progress, rate finished reads, and capture highlights as you go."
                        cta={
                            <Button
                                onClick={() => setFormOpen(true)}
                                variant="brand"
                                size="lg"
                                className="mt-2 gap-2"
                                data-testid="add-reading-button"
                            >
                                <Plus className="h-5 w-5" />
                                Add your first read
                            </Button>
                        }
                    />
                </div>

                <ReadingForm
                    open={formOpen}
                    onOpenChange={setFormOpen}
                    onSubmit={async (input) => {
                        await addItem(input);
                    }}
                    existingTags={getAllTags()}
                />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout title="Reading List" description="Your books, articles, progress and highlights">
            <div className="flex flex-col gap-6">
                {/* Summary stats */}
                <div className="grid grid-cols-3 gap-3" data-testid="reading-stats">
                    <StatTile
                        icon={<BookMarked />}
                        label="To read"
                        value={grouped.to_read.length}
                        valueColor="text-foreground"
                    />
                    <StatTile
                        icon={<BookOpen />}
                        label="Reading"
                        value={grouped.reading.length}
                        valueColor="text-primary"
                    />
                    <StatTile
                        icon={<CheckCircle2 />}
                        label="Finished"
                        value={grouped.done.length}
                        valueColor="text-emerald-400"
                    />
                </div>

                {/* Shelf columns */}
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                    {COLUMNS.map((col) => {
                        const colItems = grouped[col.status];
                        const ColIcon = col.icon;
                        return (
                            <section key={col.status} className="flex flex-col gap-3" data-testid={col.testId}>
                                <div className="flex items-center gap-2 border-b border-border pb-2">
                                    <ColIcon className="h-4 w-4 text-primary" />
                                    <h3 className="text-sm font-semibold text-foreground">{col.label}</h3>
                                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
                                        {colItems.length}
                                    </span>
                                </div>

                                {colItems.length === 0 ? (
                                    <p className="rounded-lg border border-dashed border-border/60 px-3 py-8 text-center text-xs text-muted-foreground/60">
                                        Nothing here yet
                                    </p>
                                ) : (
                                    <div className="flex flex-col gap-3">
                                        {colItems.map((item, i) => (
                                            <AnimatedCard key={item.id} index={i} stagger={40}>
                                                <ReadingCard
                                                    item={item}
                                                    onSetStatus={setStatus}
                                                    onSetPage={setCurrentPage}
                                                    onSetRating={setRating}
                                                    onOpenDetail={setDetailItem}
                                                    onDelete={removeItem}
                                                />
                                            </AnimatedCard>
                                        ))}
                                    </div>
                                )}
                            </section>
                        );
                    })}
                </div>
            </div>

            <div data-testid="add-reading-button">
                <FloatingActionButton icon={Plus} onClick={() => setFormOpen(true)} label="Add to reading list" />
            </div>

            <ReadingForm
                open={formOpen}
                onOpenChange={setFormOpen}
                onSubmit={async (input) => {
                    await addItem(input);
                }}
                existingTags={getAllTags()}
            />

            <ReadingDetailDialog item={detailItem} onOpenChange={(open) => !open && setDetailItem(null)} />
        </DashboardLayout>
    );
}
