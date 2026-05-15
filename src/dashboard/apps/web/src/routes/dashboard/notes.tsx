import { createFileRoute } from "@tanstack/react-router";
import { ComingSoonCard } from "@ui/custom";
import { FolderOpen, Hash, Search, StickyNote } from "lucide-react";
import { DashboardLayout } from "@/components/dashboard";

export const Route = createFileRoute("/dashboard/notes")({
    component: QuickNotesPage,
});

function QuickNotesPage() {
    return (
        <DashboardLayout title="Quick Notes" description="Capture thoughts instantly with markdown support and tagging">
            <ComingSoonCard
                color="emerald"
                icon={StickyNote}
                title="Quick Notes"
                description="Lightning-fast note-taking with full markdown support. Tag, search, and organize your thoughts effortlessly."
                features={[
                    { icon: Hash, label: "Smart Tagging" },
                    { icon: Search, label: "Full-Text Search" },
                    { icon: FolderOpen, label: "Smart Folders" },
                ]}
                ornament={
                    <div className="absolute -bottom-1 -right-1 rotate-12">
                        <div className="h-4 w-3 bg-emerald-500/20 border border-emerald-500/30 rounded-sm" />
                    </div>
                }
            />
        </DashboardLayout>
    );
}
