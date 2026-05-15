import { createFileRoute } from "@tanstack/react-router";
import { ComingSoonCard } from "@ui/custom";
import { BarChart3, Shield, Target, Timer } from "lucide-react";
import { DashboardLayout } from "@/components/dashboard";

export const Route = createFileRoute("/dashboard/focus")({
    component: FocusModePage,
});

function FocusModePage() {
    return (
        <DashboardLayout
            title="Focus Mode"
            description="Deep work sessions with Pomodoro technique and distraction blocking"
        >
            <ComingSoonCard
                color="amber"
                icon={Target}
                title="Focus Mode"
                description="Achieve deep work with intelligent focus sessions. Combines Pomodoro technique with distraction blocking for maximum productivity."
                features={[
                    { icon: Timer, label: "Pomodoro Timer" },
                    { icon: Shield, label: "Block Distractions" },
                    { icon: BarChart3, label: "Focus Analytics" },
                ]}
                ornament={
                    <>
                        <div className="absolute -top-1 -right-1 h-3 w-3 bg-amber-400 rounded-full animate-ping" />
                        <div className="absolute -top-1 -right-1 h-3 w-3 bg-amber-400 rounded-full" />
                    </>
                }
            />
        </DashboardLayout>
    );
}
