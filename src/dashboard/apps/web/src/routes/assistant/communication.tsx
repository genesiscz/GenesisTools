import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Loader2, MessageSquare, Plus } from "lucide-react";
import { useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { Button } from "@/components/ui/button";
import { useCommunicationLog } from "@/lib/assistant/hooks";
import type { CommunicationEntry, CommunicationEntryInput, CommunicationEntryUpdate } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import { CommunicationLog, LogForm } from "./-components/communication";

export const Route = createFileRoute("/assistant/communication")({
    component: CommunicationPage,
});

function CommunicationPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? null;

    const { entries, loading, initialized, createEntry, updateEntry, deleteEntry, getAllTags } =
        useCommunicationLog(userId);

    const [formOpen, setFormOpen] = useState(false);
    const [editingEntry, setEditingEntry] = useState<CommunicationEntry | null>(null);

    // Handle create entry
    async function handleCreate(input: CommunicationEntryInput) {
        await createEntry(input);
    }

    // Handle update entry
    async function handleUpdate(input: CommunicationEntryInput) {
        if (!editingEntry) {
            return;
        }

        const updates: CommunicationEntryUpdate = {
            title: input.title,
            content: input.content,
            sourceUrl: input.sourceUrl,
            discussedAt: input.discussedAt,
            sentiment: input.sentiment,
            tags: input.tags,
        };

        await updateEntry(editingEntry.id, updates);
        setEditingEntry(null);
    }

    // Handle delete entry
    async function handleDelete(id: string) {
        await deleteEntry(id);
    }

    // Handle edit click
    function handleEditClick(entry: CommunicationEntry) {
        setEditingEntry(entry);
        setFormOpen(true);
    }

    // Handle form close
    function handleFormClose(open: boolean) {
        setFormOpen(open);
        if (!open) {
            setEditingEntry(null);
        }
    }

    // Loading state
    if (authLoading || (!initialized && loading)) {
        return (
            <DashboardLayout title="Communication Log" description="Capture important messages and decisions">
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="flex flex-col items-center gap-4">
                        <Loader2 className="h-8 w-8 text-purple-400 animate-spin" />
                        <span className="text-muted-foreground text-sm font-mono">Loading communications...</span>
                    </div>
                </div>
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout
            title="Communication Log"
            description="Capture important messages and decisions from Slack, GitHub, email, and meetings"
        >
            {/* Main content */}
            {entries.length === 0 ? (
                <EmptyState onAddEntry={() => setFormOpen(true)} />
            ) : (
                <div className="relative min-h-[60vh]">
                    <CommunicationLog
                        entries={entries}
                        onEdit={handleEditClick}
                        onDelete={handleDelete}
                        className="max-w-4xl mx-auto"
                    />

                    {/* Floating Add button */}
                    <Button
                        onClick={() => setFormOpen(true)}
                        size="lg"
                        className={cn(
                            "fixed bottom-8 right-8 h-14 w-14 rounded-full p-0",
                            "bg-purple-600 hover:bg-purple-700",
                            "shadow-lg shadow-purple-500/20",
                            "hover:shadow-xl hover:shadow-purple-500/30",
                            "transition-all duration-200",
                            "z-50"
                        )}
                    >
                        <Plus className="h-6 w-6" />
                    </Button>
                </div>
            )}

            {/* Create/Edit form dialog */}
            <LogForm
                open={formOpen}
                onOpenChange={handleFormClose}
                onSubmit={editingEntry ? handleUpdate : handleCreate}
                initialValues={editingEntry ?? undefined}
                isEdit={!!editingEntry}
                existingTags={getAllTags()}
            />
        </DashboardLayout>
    );
}

/**
 * Empty state component
 */
function EmptyState({ onAddEntry }: { onAddEntry: () => void }) {
    return (
        <div className="flex flex-col items-center justify-center py-24 px-6">
            {/* Decorative element */}
            <div
                className={cn(
                    "relative w-32 h-32 mb-8",
                    "flex items-center justify-center",
                    "rounded-full",
                    "bg-gradient-to-br from-purple-500/10 to-purple-500/5",
                    "border border-purple-500/20",
                    "animate-pulse-glow"
                )}
            >
                <div className="absolute inset-0 rounded-full border border-purple-500/20 animate-ripple" />
                <div className="absolute inset-0 rounded-full border border-purple-500/20 animate-ripple-delayed" />
                <MessageSquare className="h-12 w-12 text-purple-400/50" />
            </div>

            {/* Text */}
            <h2 className="text-xl font-semibold text-foreground/70 mb-2">No communications logged yet</h2>
            <p className="text-muted-foreground text-center max-w-md mb-8">
                Start capturing important messages, decisions, and context from your daily communications. Never lose
                track of key discussions again.
            </p>

            {/* Feature list */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg mb-8">
                <FeatureItem icon="slack" title="Slack Messages" description="Save important threads" />
                <FeatureItem icon="github" title="GitHub Discussions" description="PR comments & issues" />
                <FeatureItem icon="email" title="Email Threads" description="Key email exchanges" />
                <FeatureItem icon="meeting" title="Meeting Notes" description="Decisions & action items" />
            </div>

            {/* CTA Button */}
            <Button onClick={onAddEntry} size="lg" className="gap-3 bg-purple-600 hover:bg-purple-700">
                <Plus className="h-5 w-5" />
                Log your first communication
            </Button>
        </div>
    );
}

/**
 * Feature item for empty state
 */
function FeatureItem({
    icon,
    title,
    description,
}: {
    icon: "slack" | "github" | "email" | "meeting";
    title: string;
    description: string;
}) {
    const colors = {
        slack: "text-purple-400 bg-purple-500/10 border-purple-500/20",
        github: "text-gray-400 bg-gray-500/10 border-gray-500/20",
        email: "text-blue-400 bg-blue-500/10 border-blue-500/20",
        meeting: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    };

    return (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
            <div className={cn("w-8 h-8 rounded flex items-center justify-center border", colors[icon])}>
                <span className="text-sm font-bold">{icon[0].toUpperCase()}</span>
            </div>
            <div>
                <h3 className="text-sm font-medium text-foreground">{title}</h3>
                <p className="text-xs text-muted-foreground">{description}</p>
            </div>
        </div>
    );
}
