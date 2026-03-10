import { createFileRoute } from "@tanstack/react-router";
import { Bell, FolderOpen, Hash, Search, StickyNote } from "lucide-react";
import { DashboardLayout } from "@/components/dashboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    FeatureCard,
    FeatureCardContent,
    FeatureCardDescription,
    FeatureCardHeader,
    FeatureCardTitle,
} from "@/components/ui/feature-card";

export const Route = createFileRoute("/dashboard/notes")({
    component: QuickNotesPage,
});

function QuickNotesPage() {
    return (
        <DashboardLayout title="Quick Notes" description="Capture thoughts instantly with markdown support and tagging">
            <div className="flex items-center justify-center min-h-[60vh]">
                <FeatureCard color="emerald" className="max-w-lg w-full">
                    <FeatureCardHeader className="text-center">
                        <div className="flex justify-center mb-4">
                            <div className="relative">
                                <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
                                    <StickyNote className="h-12 w-12 text-emerald-400" />
                                </div>
                                <div className="absolute -bottom-1 -right-1 rotate-12">
                                    <div className="h-4 w-3 bg-emerald-500/20 border border-emerald-500/30 rounded-sm" />
                                </div>
                            </div>
                        </div>

                        <Badge
                            variant="outline"
                            className="mx-auto mb-3 bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs"
                        >
                            Coming Soon
                        </Badge>

                        <FeatureCardTitle>Quick Notes</FeatureCardTitle>
                        <FeatureCardDescription className="max-w-sm mx-auto">
                            Lightning-fast note-taking with full markdown support. Tag, search, and organize your
                            thoughts effortlessly.
                        </FeatureCardDescription>
                    </FeatureCardHeader>

                    <FeatureCardContent className="space-y-6">
                        {/* Feature preview */}
                        <div className="grid grid-cols-3 gap-3">
                            <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                                <Hash className="h-5 w-5 text-emerald-400/60" />
                                <span className="text-[10px] text-muted-foreground text-center">Smart Tagging</span>
                            </div>
                            <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                                <Search className="h-5 w-5 text-emerald-400/60" />
                                <span className="text-[10px] text-muted-foreground text-center">Full-Text Search</span>
                            </div>
                            <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                                <FolderOpen className="h-5 w-5 text-emerald-400/60" />
                                <span className="text-[10px] text-muted-foreground text-center">Smart Folders</span>
                            </div>
                        </div>

                        <div className="flex flex-col items-center gap-3">
                            <Button className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 hover:text-emerald-300">
                                <Bell className="h-4 w-4 mr-2" />
                                Notify Me When Available
                            </Button>
                            <p className="text-[10px] text-muted-foreground">
                                Be the first to know when this feature launches
                            </p>
                        </div>
                    </FeatureCardContent>
                </FeatureCard>
            </div>
        </DashboardLayout>
    );
}
