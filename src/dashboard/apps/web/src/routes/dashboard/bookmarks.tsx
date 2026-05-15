import { createFileRoute } from "@tanstack/react-router";
import { ComingSoonCard } from "@ui/custom";
import { Bookmark, FolderTree, Globe, Sparkles } from "lucide-react";
import { DashboardLayout } from "@/components/dashboard";

export const Route = createFileRoute("/dashboard/bookmarks")({
    component: BookmarksPage,
});

function BookmarksPage() {
    return (
        <DashboardLayout title="Bookmarks" description="Save and organize links with AI-powered summaries and search">
            <ComingSoonCard
                color="rose"
                icon={Bookmark}
                title="Bookmarks"
                description="Never lose a link again. AI-powered bookmark manager with automatic summaries, smart categorization, and instant search."
                features={[
                    { icon: Sparkles, label: "AI Summaries" },
                    { icon: Globe, label: "Browser Sync" },
                    { icon: FolderTree, label: "Smart Collections" },
                ]}
                ornament={
                    <>
                        <div className="absolute -top-2 -left-2">
                            <div className="h-2 w-2 bg-rose-400 rounded-full animate-pulse" />
                        </div>
                        <div className="absolute -bottom-1 -right-2">
                            <div className="h-1.5 w-1.5 bg-rose-400/60 rounded-full animate-pulse delay-150" />
                        </div>
                    </>
                }
            />
        </DashboardLayout>
    );
}
