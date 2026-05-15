import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { KbdShortcut, PageLoadingSpinner, EmptyState as SharedEmptyState, StatusBadge } from "@ui/custom";
import { FeatureCard, FeatureCardContent, FeatureCardHeader } from "@ui/custom/feature-card-nexus";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Archive, ArrowRight, CheckCircle, Clock, Filter, ParkingCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { useTaskStore } from "@/lib/assistant/hooks";
import type { ContextParking, ParkingStatus } from "@/lib/assistant/types";
import { formatParkingRelativeTime } from "@/lib/assistant/utils";

export const Route = createFileRoute("/assistant/parking")({
    component: ParkingPage,
});

type FilterMode = "all" | ParkingStatus;

function ParkingPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? null;

    const { tasks, loading, initialized, getParkingHistory, resumeParking } = useTaskStore(userId);

    const [parkingHistory, setParkingHistory] = useState<ContextParking[]>([]);
    const [historyLoading, setHistoryLoading] = useState(true);
    const [filterMode, setFilterMode] = useState<FilterMode>("all");

    // Load parking history
    useEffect(() => {
        let mounted = true;

        async function loadHistory() {
            if (!userId) {
                setParkingHistory([]);
                setHistoryLoading(false);
                return;
            }

            if (!initialized) {
                setHistoryLoading(true);
                return;
            }

            setHistoryLoading(true);
            try {
                const history = await getParkingHistory();
                if (mounted) {
                    setParkingHistory(history);
                }
            } finally {
                if (mounted) {
                    setHistoryLoading(false);
                }
            }
        }

        loadHistory();

        return () => {
            mounted = false;
        };
        // getParkingHistory intentionally omitted: it's a non-memoized closure
        // over parkingsQuery.data and would re-fire this effect every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId, initialized]);

    // Filter parking entries
    const filteredHistory = parkingHistory.filter((p) => {
        if (filterMode === "all") {
            return true;
        }
        return p.status === filterMode;
    });

    // Group by task
    const groupedByTask = filteredHistory.reduce(
        (acc, parking) => {
            const taskId = parking.taskId;
            if (!acc[taskId]) {
                acc[taskId] = [];
            }
            acc[taskId].push(parking);
            return acc;
        },
        {} as Record<string, ContextParking[]>
    );

    // Get task title by ID
    function getTaskTitle(taskId: string): string {
        const task = tasks.find((t) => t.id === taskId);
        return task?.title ?? "Unknown Task";
    }

    // Handle resume
    async function handleResume(parkingId: string) {
        await resumeParking(parkingId);
        // Refresh history
        const history = await getParkingHistory();
        setParkingHistory(history);
    }

    // Counts for filter
    const counts = {
        all: parkingHistory.length,
        active: parkingHistory.filter((p) => p.status === "active").length,
        resumed: parkingHistory.filter((p) => p.status === "resumed").length,
        archived: parkingHistory.filter((p) => p.status === "archived").length,
    };

    // Loading state
    if (authLoading || (!initialized && loading) || historyLoading) {
        return (
            <DashboardLayout title="Context Parking" description="Your parked contexts">
                <PageLoadingSpinner label="Loading history..." />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout title="Context Parking" description="Your saved contexts for seamless task switching">
            {/* Toolbar */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">
                            {counts.all} parking entr{counts.all !== 1 ? "ies" : "y"}
                        </span>
                        {counts.active > 0 && (
                            <span className="flex items-center gap-1 text-purple-400 font-medium">
                                <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
                                {counts.active} active
                            </span>
                        )}
                    </div>
                </div>

                {/* Filter dropdown */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="gap-2">
                            <Filter className="h-4 w-4" />
                            <span className="hidden sm:inline capitalize">{filterMode}</span>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setFilterMode("all")}>All ({counts.all})</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setFilterMode("active")}>
                            <span className="h-2 w-2 rounded-full bg-purple-500 mr-2" />
                            Active ({counts.active})
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setFilterMode("resumed")}>
                            <span className="h-2 w-2 rounded-full bg-green-500 mr-2" />
                            Resumed ({counts.resumed})
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setFilterMode("archived")}>
                            <span className="h-2 w-2 rounded-full bg-gray-500 mr-2" />
                            Archived ({counts.archived})
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* Content */}
            {filteredHistory.length === 0 ? (
                <ParkingEmptyState filterMode={filterMode} />
            ) : (
                <div className="space-y-6">
                    {Object.entries(groupedByTask).map(([taskId, entries]) => (
                        <div key={taskId}>
                            {/* Task header */}
                            <div className="flex items-center gap-2 mb-3">
                                <Link
                                    to="/assistant/tasks/$taskId"
                                    params={{ taskId }}
                                    className="text-sm font-medium hover:text-purple-400 transition-colors"
                                >
                                    {getTaskTitle(taskId)}
                                </Link>
                                <span className="text-xs text-muted-foreground">
                                    ({entries.length} entr{entries.length !== 1 ? "ies" : "y"})
                                </span>
                            </div>

                            {/* Parking entries */}
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {entries.map((parking) => (
                                    <ParkingCard
                                        key={parking.id}
                                        parking={parking}
                                        onResume={() => handleResume(parking.id)}
                                        formatRelativeTime={formatParkingRelativeTime}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </DashboardLayout>
    );
}

/**
 * Individual parking entry card
 */
function ParkingCard({
    parking,
    onResume,
    formatRelativeTime,
}: {
    parking: ContextParking;
    onResume: () => void;
    formatRelativeTime: (date: Date) => string;
}) {
    const statusConfig = {
        active: {
            label: "Active",
            icon: ParkingCircle,
            color: "text-purple-400",
            bg: "bg-purple-500/20",
        },
        resumed: {
            label: "Resumed",
            icon: CheckCircle,
            color: "text-green-400",
            bg: "bg-green-500/20",
        },
        archived: {
            label: "Archived",
            icon: Archive,
            color: "text-gray-400",
            bg: "bg-gray-500/20",
        },
    };

    const status = statusConfig[parking.status];
    const StatusIcon = status.icon;

    return (
        <FeatureCard color="purple" className="h-full">
            <FeatureCardHeader className="pb-2">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatRelativeTime(new Date(parking.parkedAt))}
                    </div>
                    <StatusBadge
                        bgClass={status.bg}
                        textClass={status.color}
                        shape="flat"
                        className="gap-1 tracking-wider"
                        icon={<StatusIcon className="h-3 w-3" />}
                    >
                        {status.label}
                    </StatusBadge>
                </div>

                <p className="text-sm leading-relaxed">{parking.content}</p>

                {parking.nextSteps && (
                    <div className="mt-3 pt-3 border-t border-purple-500/20">
                        <span className="text-xs text-purple-300 font-medium">Next steps:</span>
                        <p className="text-sm text-foreground/80 mt-1">{parking.nextSteps}</p>
                    </div>
                )}
            </FeatureCardHeader>

            {parking.status === "active" && (
                <FeatureCardContent className="pt-0">
                    <Button size="sm" onClick={onResume} variant="brand" className="w-full gap-2">
                        Resume
                        <ArrowRight className="h-4 w-4" />
                    </Button>
                </FeatureCardContent>
            )}
        </FeatureCard>
    );
}

/**
 * Empty state
 */
function ParkingEmptyState({ filterMode }: { filterMode: FilterMode }) {
    const getMessage = () => {
        switch (filterMode) {
            case "active":
                return {
                    title: "No active parkings",
                    description: "All your parked contexts have been resumed or archived.",
                };
            case "resumed":
                return {
                    title: "No resumed parkings",
                    description: "You haven't resumed any parked contexts yet.",
                };
            case "archived":
                return {
                    title: "No archived parkings",
                    description: "No old parking entries to show.",
                };
            default:
                return {
                    title: "No parking history",
                    description: "When you switch tasks, press Cmd+P to save your context. It will show up here.",
                };
        }
    };

    const message = getMessage();

    return (
        <SharedEmptyState
            icon={ParkingCircle}
            title={message.title}
            description={message.description}
            descriptionClassName="mb-4"
            rings={false}
            cta={
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <KbdShortcut keys={["Cmd", "P"]} />
                    <span>to park context</span>
                </div>
            }
        />
    );
}
