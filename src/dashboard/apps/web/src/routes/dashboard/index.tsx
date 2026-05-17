import { createFileRoute, Link } from "@tanstack/react-router";
import { FeatureGrid, type FeatureGridItem, HeroBanner, SectionHeader, StatCardNexus } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Bookmark, Brain, CalendarDays, Clock, Sparkles, StickyNote, Target, Timer, TrendingUp } from "lucide-react";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";

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
        badge: "Coming Soon",
    },
    {
        title: "Focus Mode",
        description: "Deep work sessions with Pomodoro technique and distraction blocking",
        icon: Target,
        href: "/dashboard/focus",
        color: "amber",
        badge: "Coming Soon",
    },
    {
        title: "Quick Notes",
        description: "Capture thoughts instantly with markdown support and tagging",
        icon: StickyNote,
        href: "/dashboard/notes",
        color: "emerald",
        badge: "Coming Soon",
    },
    {
        title: "Bookmarks",
        description: "Save and organize links with AI-powered summaries and search",
        icon: Bookmark,
        href: "/dashboard/bookmarks",
        color: "rose",
        badge: "Coming Soon",
    },
    {
        title: "Daily Planner",
        description: "AI-assisted daily planning with smart scheduling and reminders",
        icon: CalendarDays,
        href: "/dashboard/planner",
        color: "blue",
        badge: "Coming Soon",
    },
];

function DashboardPage() {
    const { user } = useAuth();

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
                        <StatCardNexus icon={<Clock />} value="0:00:00" label="Time Today" color="accent" />
                        <StatCardNexus icon={<TrendingUp />} value="0" label="Tasks Done" color="primary" />
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
