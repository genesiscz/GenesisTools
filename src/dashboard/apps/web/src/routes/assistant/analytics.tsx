import { createFileRoute } from "@tanstack/react-router";
import { IconSectionHeader, PageLoadingSpinner } from "@ui/custom";
import { FeatureCard } from "@ui/custom/feature-card-nexus";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Activity, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { useDistractions, useEnergyData, useTaskStore } from "@/lib/assistant/hooks";
import { useBadgeProgress } from "@/lib/assistant/hooks/useBadgeProgress";
import type { DistractionStats as DistractionStatsType, EnergyHeatmapData } from "@/lib/assistant/lib/storage/types";
import type { Badge, DistractionSource, Task } from "@/lib/assistant/types";
import {
    EmptyHeatmap,
    EnergyHeatmap,
    EnergyInsights,
    FocusRecommendation,
    LogEnergyButton,
    WeeklyReview,
} from "./-components/analytics";
import {
    BadgeProgress,
    BadgeShowcase,
    BadgeUnlockAnimation,
    NextBadgePreview,
    useBadgeUnlock,
} from "./-components/badges";
import { DistractionInsights, DistractionPatterns, DistractionStats, QuickLogButton } from "./-components/distractions";

export const Route = createFileRoute("/assistant/analytics")({
    component: AnalyticsPage,
});

function AnalyticsPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? null;

    const { tasks, badges, loading: tasksLoading, initialized } = useTaskStore(userId);
    const badgeProgressHook = useBadgeProgress(userId);

    // Energy data hook
    const energyData = useEnergyData(userId);
    const [heatmapData, setHeatmapData] = useState<EnergyHeatmapData | null>(null);
    const [heatmapLoading, setHeatmapLoading] = useState(false);

    // Distraction data hook
    const distractionData = useDistractions(userId);
    const [distractionStats, setDistractionStats] = useState<DistractionStatsType | null>(null);
    const [distractionTrend, setDistractionTrend] = useState<"improving" | "worsening" | "stable">("stable");
    const [statsLoading, setStatsLoading] = useState(false);

    // Get current active task (for distraction logging)
    const currentTask: Task | null = tasks.find((t) => t.status === "in-progress") ?? null;

    // Load heatmap data
    useEffect(() => {
        async function loadHeatmap() {
            if (!userId) {
                return;
            }

            setHeatmapLoading(true);
            try {
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - 30); // Last 30 days

                const data = await energyData.getHeatmapData(startDate, endDate);
                setHeatmapData(data);
            } finally {
                setHeatmapLoading(false);
            }
        }

        if (userId && !energyData.loading) {
            loadHeatmap();
        }
    }, [userId, energyData.loading, energyData.getHeatmapData]);

    // Load distraction stats
    useEffect(() => {
        async function loadDistractionStats() {
            if (!userId) {
                return;
            }

            setStatsLoading(true);
            try {
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - 7); // Last 7 days

                const stats = await distractionData.getStats(startDate, endDate);
                setDistractionStats(stats);

                const trend = await distractionData.getDistractionTrend();
                setDistractionTrend(trend);
            } finally {
                setStatsLoading(false);
            }
        }

        if (userId && !distractionData.loading) {
            loadDistractionStats();
        }
    }, [userId, distractionData.loading, distractionData.getDistractionTrend, distractionData.getStats]);

    // Badge unlock animation state
    const badgeUnlock = useBadgeUnlock();

    // Handle badge click to show detail
    const [selectedBadge, setSelectedBadge] = useState<Badge | null>(null);

    function handleBadgeClick(badge: Badge) {
        setSelectedBadge(badge);
        badgeUnlock.showUnlock(badge);
    }

    // Handle logging energy
    async function handleLogEnergy(input: Parameters<typeof energyData.logSnapshot>[0]) {
        await energyData.logSnapshot(input);
        // Reload heatmap data after logging
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        const data = await energyData.getHeatmapData(startDate, endDate);
        setHeatmapData(data);
    }

    // Handle logging distraction
    async function handleLogDistraction(source: DistractionSource, description?: string, taskInterrupted?: string) {
        await distractionData.logDistraction({
            source,
            description,
            taskInterrupted,
            resumedTask: false,
        });
        // Reload stats after logging
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
        const stats = await distractionData.getStats(startDate, endDate);
        setDistractionStats(stats);
    }

    // Loading state
    if (authLoading || (!initialized && tasksLoading)) {
        return (
            <DashboardLayout title="Analytics" description="Productivity insights and patterns">
                <PageLoadingSpinner label="Loading analytics..." />
            </DashboardLayout>
        );
    }

    // Get next achievable badge
    const nextBadge = badgeProgressHook.getNextAchievableBadge();

    // Get energy analytics
    const trend = energyData.getFocusQualityTrend();
    const averageFocusQuality = energyData.getAverageFocusQuality();
    const totalContextSwitches = energyData.getTotalContextSwitches();

    // Suppress unused variable warning for selectedBadge
    void selectedBadge;

    return (
        <DashboardLayout title="Analytics" description="Productivity insights and patterns">
            <div className="space-y-8 max-w-6xl mx-auto">
                {/* Weekly Review Dashboard - Main Section */}
                <section>
                    <WeeklyReview userId={userId} />
                </section>

                {/* Focus Recommendation Banner */}
                <FocusRecommendation heatmapData={heatmapData} tasks={tasks} />

                {/* Energy Heatmap Section */}
                <section className="space-y-4">
                    <IconSectionHeader
                        icon={<Activity />}
                        title="Energy Heatmap"
                        subtitle="Your productivity patterns over the last 30 days"
                        iconBgClass="bg-cyan-500/10"
                        iconBorderClass="border-cyan-500/20"
                        iconColorClass="text-cyan-400"
                        actions={<LogEnergyButton onLogEnergy={handleLogEnergy} loading={energyData.loading} />}
                    />

                    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
                        {/* Heatmap Grid */}
                        <FeatureCard color="cyan" className="p-6">
                            {energyData.snapshots.length > 0 || heatmapLoading ? (
                                <EnergyHeatmap data={heatmapData} loading={heatmapLoading} />
                            ) : (
                                <EmptyHeatmap />
                            )}
                        </FeatureCard>

                        {/* Insights Panel */}
                        <FeatureCard color="purple" className="p-6">
                            <EnergyInsights
                                data={heatmapData}
                                snapshots={energyData.snapshots}
                                trend={trend}
                                averageFocusQuality={averageFocusQuality}
                                totalContextSwitches={totalContextSwitches}
                            />
                        </FeatureCard>
                    </div>
                </section>

                {/* Distraction Tracker Section */}
                <section className="space-y-4">
                    <IconSectionHeader
                        icon={<Zap />}
                        title="Distraction Tracker"
                        subtitle="Understand and reduce interruptions (Last 7 days)"
                        iconBgClass="bg-cyan-500/10"
                        iconBorderClass="border-cyan-500/20"
                        iconColorClass="text-cyan-400"
                    />

                    <div className="grid gap-6 lg:grid-cols-2">
                        {/* Distribution chart */}
                        <DistractionStats stats={distractionStats} trend={distractionTrend} loading={statsLoading} />

                        {/* Pattern analysis */}
                        <DistractionPatterns
                            distractions={distractionData.distractions}
                            loading={distractionData.loading}
                        />
                    </div>

                    {/* Insights and recommendations */}
                    <DistractionInsights stats={distractionStats} distractions={distractionData.distractions} />
                </section>

                {/* Badges Section */}
                <section className="space-y-6">
                    {/* Next badge preview + earned badges row */}
                    <div className="grid gap-6 md:grid-cols-[300px_1fr]">
                        {/* Next badge preview */}
                        {nextBadge && (
                            <div className="md:row-span-2">
                                <NextBadgePreview progress={nextBadge} />
                            </div>
                        )}

                        {/* Earned badges showcase */}
                        <FeatureCard color="amber" className="p-6">
                            <BadgeShowcase
                                badges={badges}
                                loading={badgeProgressHook.loading}
                                onBadgeClick={handleBadgeClick}
                            />
                        </FeatureCard>
                    </div>

                    {/* In-progress badges */}
                    <FeatureCard color="cyan" className="p-6">
                        <BadgeProgress
                            progressList={badgeProgressHook.progress}
                            loading={badgeProgressHook.loading}
                            maxItems={6}
                            minPercent={5}
                        />
                    </FeatureCard>
                </section>
            </div>

            {/* Floating quick log button */}
            <QuickLogButton onLog={handleLogDistraction} currentTask={currentTask} loading={distractionData.loading} />

            {/* Badge unlock animation modal */}
            <BadgeUnlockAnimation
                badge={badgeUnlock.unlockedBadge}
                open={badgeUnlock.isOpen}
                onClose={badgeUnlock.closeUnlock}
            />
        </DashboardLayout>
    );
}
