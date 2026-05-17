import { createFileRoute, Link } from "@tanstack/react-router";
import { FeatureGrid, type FeatureGridItem, HeroBanner, SectionHeader, StatCardNexus } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Bookmark, Brain, CalendarDays, Clock, Sparkles, StickyNote, Target, Timer, TrendingUp } from "lucide-react";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { useAssistantTasksQuery } from "@/lib/assistant/hooks/useAssistantQueries";
import { useAggregatedFocusStats } from "./-focus/useFocusStats";

function formatHms(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const Route = createFileRoute("/dashboard/")({
    component: DashboardPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

const features: FeatureGridItem[] = [
    {
        title: "Timer",
        description: "Precision time tracking with stopwatch and countdown modes",
        icon: Timer,
        href: "/timer",
        color: "cyan",
        badge: "Active",
    },
    {
        title: "AI Assistant",
        description: "Your personal AI companion for tasks, research, and creativity",
        icon: Brain,
        href: "/dashboard/ai",
        color: "purple",
        badge: "Active",
    },
    {
        title: "Focus Mode",
        description: "Deep work sessions with Pomodoro technique and distraction blocking",
        icon: Target,
        href: "/dashboard/focus",
        color: "amber",
        badge: "Active",
    },
    {
        title: "Quick Notes",
        description: "Capture thoughts instantly with markdown support and tagging",
        icon: StickyNote,
        href: "/dashboard/notes",
        color: "emerald",
        badge: "Active",
    },
    {
        title: "Bookmarks",
        description: "Save and organize links with page-metadata previews and search",
        icon: Bookmark,
        href: "/dashboard/bookmarks",
        color: "rose",
        badge: "Active",
    },
    {
        title: "Daily Planner",
        description: "Day-view timeline — drag tasks to schedule, with focus-session overlays",
        icon: CalendarDays,
        href: "/dashboard/planner",
        color: "blue",
        badge: "Active",
    },
];

function DashboardPage() {
    const { user } = useAuth();
    const userId = user?.id ?? null;

    const focusStats = useAggregatedFocusStats(userId);
    const tasksQuery = useAssistantTasksQuery(userId);
    const timeToday = userId ? formatHms(focusStats.timeFocusedTodayMs) : "—";
    const tasksDone = tasksQuery.data ? String(tasksQuery.data.filter((t) => t.status === "completed").length) : "—";

    const greeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) {
            return "Good morning";
        }

        if (hour < 18) {
            return "Good afternoon";
        }

        return "Good evening";
    };

    return (
        <DashboardLayout title="Dashboard" description="Your personal command center">
            <div className="space-y-8">
                <HeroBanner
                    eyebrow="Welcome Back"
                    eyebrowIcon={<Sparkles className="h-3 w-3 animate-pulse-subtle" />}
                    title={
                        <>
                            {greeting()}, <span className="gradient-text">{user?.firstName || "Commander"}</span>
                        </>
                    }
                    description="Your NEXUS command center is online. All systems operational and ready to optimize your productivity."
                >
                    <div className="flex gap-6 mt-8">
                        <StatCardNexus icon={<Clock />} value={timeToday} label="Time Today" color="accent" />
                        <StatCardNexus icon={<TrendingUp />} value={tasksDone} label="Tasks Done" color="primary" />
                    </div>
                </HeroBanner>

                <div>
                    <SectionHeader
                        title="Tools & Features"
                        subtitle="Your productivity toolkit"
                        badge={`${features.filter((feature) => feature.badge === "Active").length}/${features.length} Active`}
                    />
                    <FeatureGrid items={features} LinkComponent={Link} />
                </div>
            </div>
        </DashboardLayout>
    );
}
