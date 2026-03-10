import {
    BellOff,
    Calendar,
    CheckCircle,
    ChevronRight,
    Clock,
    Coffee,
    FlaskConical,
    Lightbulb,
    Shield,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { FeatureCard, FeatureCardContent, FeatureCardHeader } from "@/components/ui/feature-card";
import type { DistractionStats } from "@/lib/assistant/lib/storage/types";
import type { Distraction } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface DistractionInsightsProps {
    stats: DistractionStats | null;
    distractions: Distraction[];
    className?: string;
}

interface Recommendation {
    id: string;
    icon: typeof Lightbulb;
    title: string;
    description: string;
    action?: string;
    color: "cyan" | "purple" | "amber" | "green";
    priority: number;
}

interface Experiment {
    id: string;
    title: string;
    duration: string;
    started?: Date;
    completed?: boolean;
}

/**
 * Generate recommendations based on distraction data
 */
function generateRecommendations(stats: DistractionStats | null, distractions: Distraction[]): Recommendation[] {
    const recommendations: Recommendation[] = [];

    if (!stats || distractions.length === 0) {
        recommendations.push({
            id: "start-tracking",
            icon: Lightbulb,
            title: "Start tracking distractions",
            description:
                "Log interruptions as they happen to discover your patterns and get personalized recommendations.",
            color: "cyan",
            priority: 1,
        });
        return recommendations;
    }

    const { mostCommonSource, bySource, averagePerDay, resumptionRate } = stats;

    // Slack/Chat recommendations
    if (mostCommonSource === "slack" || (bySource.slack && bySource.slack.count >= 3)) {
        recommendations.push({
            id: "mute-slack",
            icon: BellOff,
            title: "Mute Slack during focus time",
            description: "Try enabling Do Not Disturb from 9-11am. Slack is your biggest distraction source.",
            action: "Set up focus mode",
            color: "cyan",
            priority: 1,
        });
    }

    // Email recommendations
    if (mostCommonSource === "email" || (bySource.email && bySource.email.count >= 3)) {
        recommendations.push({
            id: "batch-email",
            icon: Calendar,
            title: "Batch process emails",
            description: "Check email only at 9am, 1pm, and 5pm instead of continuously throughout the day.",
            action: "Schedule email blocks",
            color: "purple",
            priority: 2,
        });
    }

    // Meeting recommendations
    if (bySource.meeting && bySource.meeting.count >= 2) {
        recommendations.push({
            id: "meeting-days",
            icon: Shield,
            title: "Create meeting-free blocks",
            description: "Block 2-3 hours each morning for deep work. Move meetings to afternoon slots.",
            action: "Update calendar",
            color: "amber",
            priority: 2,
        });
    }

    // Hunger/break recommendations
    if (bySource.hunger && bySource.hunger.count >= 2) {
        recommendations.push({
            id: "schedule-breaks",
            icon: Coffee,
            title: "Schedule regular breaks",
            description: "Set reminders for snacks at 10:30am and 3pm to prevent hunger-driven interruptions.",
            action: "Set reminders",
            color: "amber",
            priority: 3,
        });
    }

    // Coworker recommendations
    if (bySource.coworker && bySource.coworker.count >= 2) {
        recommendations.push({
            id: "office-hours",
            icon: Clock,
            title: "Establish office hours",
            description: 'Let colleagues know your availability windows. Use a "focus" status when deep working.',
            action: "Communicate boundaries",
            color: "green",
            priority: 3,
        });
    }

    // High distraction rate
    if (averagePerDay > 5) {
        recommendations.push({
            id: "environment-audit",
            icon: Shield,
            title: "Audit your environment",
            description:
                "With 5+ daily interruptions, consider noise-canceling headphones or finding a quieter workspace.",
            color: "purple",
            priority: 1,
        });
    }

    // Low resumption rate
    if (resumptionRate < 50 && distractions.length >= 5) {
        recommendations.push({
            id: "context-parking",
            icon: Lightbulb,
            title: "Use context parking",
            description:
                "You often don't return to tasks after interruptions. Park your context before switching to make resuming easier.",
            action: "Learn more",
            color: "cyan",
            priority: 2,
        });
    }

    // Sort by priority
    return recommendations.sort((a, b) => a.priority - b.priority);
}

/**
 * Color configuration for recommendation cards
 */
const colorConfig = {
    cyan: {
        bg: "bg-cyan-500/10",
        border: "border-cyan-500/20",
        iconBg: "bg-cyan-500/20",
        iconColor: "text-cyan-400",
        buttonBg: "bg-cyan-600 hover:bg-cyan-700",
    },
    purple: {
        bg: "bg-purple-500/10",
        border: "border-purple-500/20",
        iconBg: "bg-purple-500/20",
        iconColor: "text-purple-400",
        buttonBg: "bg-purple-600 hover:bg-purple-700",
    },
    amber: {
        bg: "bg-amber-500/10",
        border: "border-amber-500/20",
        iconBg: "bg-amber-500/20",
        iconColor: "text-amber-400",
        buttonBg: "bg-amber-600 hover:bg-amber-700",
    },
    green: {
        bg: "bg-green-500/10",
        border: "border-green-500/20",
        iconBg: "bg-green-500/20",
        iconColor: "text-green-400",
        buttonBg: "bg-green-600 hover:bg-green-700",
    },
};

/**
 * DistractionInsights - AI-generated recommendations and experiments
 *
 * Features:
 * - Context-aware recommendations based on patterns
 * - Glass card styling with neon accents
 * - Experiment tracking ("Try this for 1 week")
 */
export function DistractionInsights({ stats, distractions, className }: DistractionInsightsProps) {
    const [activeExperiment, setActiveExperiment] = useState<Experiment | null>(null);

    const recommendations = useMemo(() => generateRecommendations(stats, distractions), [stats, distractions]);

    function startExperiment(recommendation: Recommendation) {
        setActiveExperiment({
            id: recommendation.id,
            title: recommendation.title,
            duration: "1 week",
            started: new Date(),
        });
    }

    function completeExperiment() {
        if (activeExperiment) {
            setActiveExperiment({ ...activeExperiment, completed: true });
        }
    }

    return (
        <FeatureCard color="emerald" className={className}>
            <FeatureCardHeader>
                <div className="flex items-center gap-2">
                    <Lightbulb className="h-5 w-5 text-emerald-400" />
                    <h3 className="text-lg font-semibold">Insights & Recommendations</h3>
                </div>
                <p className="text-sm text-muted-foreground">Personalized suggestions based on your patterns</p>
            </FeatureCardHeader>

            <FeatureCardContent className="space-y-4">
                {/* Active experiment banner */}
                {activeExperiment && !activeExperiment.completed && (
                    <div className="p-4 rounded-lg bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 border border-emerald-500/20">
                        <div className="flex items-center gap-2 mb-2">
                            <FlaskConical className="h-4 w-4 text-emerald-400" />
                            <span className="text-sm font-medium text-emerald-400">Active Experiment</span>
                        </div>
                        <p className="text-sm font-medium mb-1">{activeExperiment.title}</p>
                        <p className="text-xs text-muted-foreground mb-3">
                            Started{" "}
                            {activeExperiment.started?.toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                            })}{" "}
                            - Try this for {activeExperiment.duration}
                        </p>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={completeExperiment}
                            className="text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                        >
                            <CheckCircle className="h-4 w-4 mr-1" />
                            Mark Complete
                        </Button>
                    </div>
                )}

                {/* Completed experiment celebration */}
                {activeExperiment?.completed && (
                    <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20">
                        <div className="flex items-center gap-2 mb-2">
                            <CheckCircle className="h-5 w-5 text-green-400" />
                            <span className="text-sm font-medium text-green-400">Experiment Completed!</span>
                        </div>
                        <p className="text-sm mb-2">Great job trying &quot;{activeExperiment.title}&quot;</p>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setActiveExperiment(null)}
                            className="text-muted-foreground"
                        >
                            Try another recommendation
                        </Button>
                    </div>
                )}

                {/* Recommendation cards */}
                {recommendations.slice(0, 3).map((rec) => {
                    const colors = colorConfig[rec.color];
                    const Icon = rec.icon;

                    return (
                        <div
                            key={rec.id}
                            className={cn(
                                "p-4 rounded-lg border backdrop-blur-sm transition-all duration-200",
                                "hover:scale-[1.02]",
                                colors.bg,
                                colors.border
                            )}
                            style={{
                                boxShadow: `0 0 20px ${
                                    rec.color === "cyan"
                                        ? "rgba(6, 182, 212, 0.1)"
                                        : rec.color === "purple"
                                          ? "rgba(168, 85, 247, 0.1)"
                                          : rec.color === "amber"
                                            ? "rgba(245, 158, 11, 0.1)"
                                            : "rgba(34, 197, 94, 0.1)"
                                }`,
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <div className={cn("p-2 rounded-lg flex-shrink-0", colors.iconBg)}>
                                    <Icon className={cn("h-5 w-5", colors.iconColor)} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h4 className="font-medium mb-1">{rec.title}</h4>
                                    <p className="text-sm text-muted-foreground">{rec.description}</p>
                                    {rec.action && !activeExperiment && (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => startExperiment(rec)}
                                            className={cn("mt-3 gap-1", colors.iconColor, `hover:${colors.bg}`)}
                                        >
                                            <FlaskConical className="h-4 w-4" />
                                            Try for 1 week
                                            <ChevronRight className="h-4 w-4" />
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {/* Empty state */}
                {recommendations.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                        <Lightbulb className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p>Log more distractions to get personalized insights</p>
                    </div>
                )}
            </FeatureCardContent>
        </FeatureCard>
    );
}
