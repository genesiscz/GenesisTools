import { createFileRoute } from "@tanstack/react-router";
import { ComingSoonCard } from "@ui/custom";
import { CalendarDays, Clock, ListChecks, Sparkles } from "lucide-react";
import { DashboardLayout } from "@/components/dashboard";

export const Route = createFileRoute("/dashboard/planner")({
    component: DailyPlannerPage,
});

function DailyPlannerPage() {
    return (
        <DashboardLayout
            title="Daily Planner"
            description="AI-assisted daily planning with smart scheduling and reminders"
        >
            <ComingSoonCard
                color="blue"
                icon={CalendarDays}
                title="Daily Planner"
                description="Plan your perfect day with AI assistance. Smart scheduling, time blocking, and intelligent reminders to keep you on track."
                features={[
                    { icon: Sparkles, label: "AI Scheduling" },
                    { icon: Clock, label: "Time Blocking" },
                    { icon: ListChecks, label: "Task Integration" },
                ]}
                ornament={
                    <div className="absolute top-0 right-0 translate-x-1/2 -translate-y-1/3">
                        <div className="px-1.5 py-0.5 bg-blue-500/20 border border-blue-500/30 rounded text-[8px] text-blue-400 font-mono">
                            {new Date().getDate()}
                        </div>
                    </div>
                }
            />
        </DashboardLayout>
    );
}
