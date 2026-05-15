import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { FloatingActionButton, IconBox, PageLoadingSpinner, EmptyState as SharedEmptyState } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { MessageSquare, Plus } from "lucide-react";
import { useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { useCommunicationLog } from "@/lib/assistant/hooks";
import type { CommunicationEntry, CommunicationEntryInput, CommunicationEntryUpdate } from "@/lib/assistant/types";
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
                <PageLoadingSpinner label="Loading communications..." />
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
                <CommunicationEmptyState onAddEntry={() => setFormOpen(true)} />
            ) : (
                <div className="relative min-h-[60vh]">
                    <CommunicationLog
                        entries={entries}
                        onEdit={handleEditClick}
                        onDelete={handleDelete}
                        className="max-w-4xl mx-auto"
                    />

                    {/* Floating Add button */}
                    <FloatingActionButton icon={Plus} onClick={() => setFormOpen(true)} label="Log entry" />
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
function CommunicationEmptyState({ onAddEntry }: { onAddEntry: () => void }) {
    return (
        <SharedEmptyState
            icon={MessageSquare}
            title="No communications logged yet"
            description="Start capturing important messages, decisions, and context from your daily communications. Never lose track of key discussions again."
            cta={
                <Button onClick={onAddEntry} size="lg" variant="brand" className="gap-3">
                    <Plus className="h-5 w-5" />
                    Log your first communication
                </Button>
            }
        >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg mb-8">
                <FeatureItem icon="slack" title="Slack Messages" description="Save important threads" />
                <FeatureItem icon="github" title="GitHub Discussions" description="PR comments & issues" />
                <FeatureItem icon="email" title="Email Threads" description="Key email exchanges" />
                <FeatureItem icon="meeting" title="Meeting Notes" description="Decisions & action items" />
            </div>
        </SharedEmptyState>
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
    const colors: Record<typeof icon, { text: string; bg: string; border: string }> = {
        slack: { text: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/20" },
        github: { text: "text-gray-400", bg: "bg-gray-500/10", border: "border-gray-500/20" },
        email: { text: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20" },
        meeting: { text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
    };
    const color = colors[icon];

    return (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
            <IconBox
                icon={<span className="text-sm font-bold">{icon[0].toUpperCase()}</span>}
                size="sm"
                bgClass={color.bg}
                borderClass={color.border}
                iconClass={color.text}
            />
            <div>
                <h3 className="text-sm font-medium text-foreground">{title}</h3>
                <p className="text-xs text-muted-foreground">{description}</p>
            </div>
        </div>
    );
}
