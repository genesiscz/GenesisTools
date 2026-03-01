import { createFileRoute } from "@tanstack/react-router";
import { BarChart3, Bell, Shield, Target, Timer } from "lucide-react";
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

export const Route = createFileRoute("/dashboard/focus")({
    component: FocusModePage,
});

function FocusModePage() {
    return (
        <DashboardLayout
            title="Focus Mode"
            description="Deep work sessions with Pomodoro technique and distraction blocking"
        >
            <div className="flex items-center justify-center min-h-[60vh]">
                <FeatureCard color="amber" className="max-w-lg w-full">
                    <FeatureCardHeader className="text-center">
                        <div className="flex justify-center mb-4">
                            <div className="relative">
                                <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20">
                                    <Target className="h-12 w-12 text-amber-400" />
                                </div>
                                <div className="absolute -top-1 -right-1 h-3 w-3 bg-amber-400 rounded-full animate-ping" />
                                <div className="absolute -top-1 -right-1 h-3 w-3 bg-amber-400 rounded-full" />
                            </div>
                        </div>

                        <Badge
                            variant="outline"
                            className="mx-auto mb-3 bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs"
                        >
                            Coming Soon
                        </Badge>

                        <FeatureCardTitle>Focus Mode</FeatureCardTitle>
                        <FeatureCardDescription className="max-w-sm mx-auto">
                            Achieve deep work with intelligent focus sessions. Combines Pomodoro technique with
                            distraction blocking for maximum productivity.
                        </FeatureCardDescription>
                    </FeatureCardHeader>

                    <FeatureCardContent className="space-y-6">
                        {/* Feature preview */}
                        <div className="grid grid-cols-3 gap-3">
                            <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                                <Timer className="h-5 w-5 text-amber-400/60" />
                                <span className="text-[10px] text-muted-foreground text-center">Pomodoro Timer</span>
                            </div>
                            <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                                <Shield className="h-5 w-5 text-amber-400/60" />
                                <span className="text-[10px] text-muted-foreground text-center">
                                    Block Distractions
                                </span>
                            </div>
                            <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                                <BarChart3 className="h-5 w-5 text-amber-400/60" />
                                <span className="text-[10px] text-muted-foreground text-center">Focus Analytics</span>
                            </div>
                        </div>

                        <div className="flex flex-col items-center gap-3">
                            <Button className="bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 hover:text-amber-300">
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
