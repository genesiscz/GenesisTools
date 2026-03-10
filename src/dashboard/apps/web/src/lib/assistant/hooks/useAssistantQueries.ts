/**
 * TanStack Query hooks for Assistant features
 *
 * Simple REST-like data fetching with:
 * - refetchOnWindowFocus for sync-on-focus
 * - 30s staleTime for caching
 * - Query key factories for cache management
 * - localStorage fallback is handled in the individual feature hooks
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
    NewAssistantBadge,
    NewAssistantBlocker,
    NewAssistantCelebration,
    NewAssistantCommunication,
    NewAssistantCompletion,
    NewAssistantContextParking,
    NewAssistantDeadlineRisk,
    NewAssistantDecision,
    NewAssistantDistraction,
    NewAssistantEnergySnapshot,
    NewAssistantHandoff,
    NewAssistantStreak,
    NewAssistantTask,
    NewAssistantWeeklyReview,
} from "@/drizzle";
import {
    createAssistantBadge,
    createAssistantBlocker,
    createAssistantCelebration,
    createAssistantCommunication,
    createAssistantCompletion,
    createAssistantContextParking,
    createAssistantDeadlineRisk,
    createAssistantDecision,
    createAssistantDistraction,
    createAssistantEnergySnapshot,
    createAssistantHandoff,
    createAssistantTask,
    createAssistantWeeklyReview,
    deleteAssistantCommunication,
    deleteAssistantDecision,
    deleteAssistantTask,
    dismissAssistantCelebration,
    // Badges
    getAssistantBadges,
    // Blockers
    getAssistantBlockers,
    getAssistantBlockersByTask,
    // Celebrations
    getAssistantCelebrations,
    // Communications
    getAssistantCommunications,
    // Completions
    getAssistantCompletions,
    // Context Parking
    getAssistantContextParkings,
    getAssistantCurrentWeekReview,
    getAssistantDeadlineRiskByTask,
    // Deadline Risks
    getAssistantDeadlineRisks,
    // Decisions
    getAssistantDecisions,
    // Distractions
    getAssistantDistractions,
    // Energy Snapshots
    getAssistantEnergySnapshots,
    // Handoffs
    getAssistantHandoffs,
    getAssistantHandoffsByTask,
    // Streaks
    getAssistantStreak,
    getAssistantTask,
    // Tasks
    getAssistantTasks,
    // Weekly Reviews
    getAssistantWeeklyReviews,
    markAssistantCelebrationShown,
    resolveAssistantBlocker,
    updateAssistantBlocker,
    updateAssistantCommunication,
    updateAssistantContextParking,
    updateAssistantDecision,
    updateAssistantHandoff,
    updateAssistantTask,
    upsertAssistantStreak,
} from "../assistant.server";

// ============================================
// Query Key Factories
// ============================================

export const assistantKeys = {
    all: ["assistant"] as const,

    // Tasks
    tasks: () => [...assistantKeys.all, "tasks"] as const,
    taskList: (userId: string) => [...assistantKeys.tasks(), "list", userId] as const,
    taskDetail: (id: string) => [...assistantKeys.tasks(), "detail", id] as const,

    // Context Parking
    parking: () => [...assistantKeys.all, "parking"] as const,
    parkingList: (userId: string) => [...assistantKeys.parking(), "list", userId] as const,

    // Completions
    completions: () => [...assistantKeys.all, "completions"] as const,
    completionList: (userId: string) => [...assistantKeys.completions(), "list", userId] as const,

    // Streaks
    streaks: () => [...assistantKeys.all, "streaks"] as const,
    streak: (userId: string) => [...assistantKeys.streaks(), userId] as const,

    // Badges
    badges: () => [...assistantKeys.all, "badges"] as const,
    badgeList: (userId: string) => [...assistantKeys.badges(), "list", userId] as const,

    // Communications
    communications: () => [...assistantKeys.all, "communications"] as const,
    communicationList: (userId: string) => [...assistantKeys.communications(), "list", userId] as const,

    // Decisions
    decisions: () => [...assistantKeys.all, "decisions"] as const,
    decisionList: (userId: string) => [...assistantKeys.decisions(), "list", userId] as const,

    // Blockers
    blockers: () => [...assistantKeys.all, "blockers"] as const,
    blockerList: (userId: string) => [...assistantKeys.blockers(), "list", userId] as const,
    blockersByTask: (taskId: string) => [...assistantKeys.blockers(), "task", taskId] as const,

    // Handoffs
    handoffs: () => [...assistantKeys.all, "handoffs"] as const,
    handoffList: (userId: string) => [...assistantKeys.handoffs(), "list", userId] as const,
    handoffsByTask: (taskId: string) => [...assistantKeys.handoffs(), "task", taskId] as const,

    // Deadline Risks
    deadlineRisks: () => [...assistantKeys.all, "deadlineRisks"] as const,
    deadlineRiskList: (userId: string) => [...assistantKeys.deadlineRisks(), "list", userId] as const,
    deadlineRiskByTask: (taskId: string) => [...assistantKeys.deadlineRisks(), "task", taskId] as const,

    // Energy Snapshots
    energySnapshots: () => [...assistantKeys.all, "energySnapshots"] as const,
    energySnapshotList: (userId: string) => [...assistantKeys.energySnapshots(), "list", userId] as const,

    // Distractions
    distractions: () => [...assistantKeys.all, "distractions"] as const,
    distractionList: (userId: string) => [...assistantKeys.distractions(), "list", userId] as const,

    // Weekly Reviews
    weeklyReviews: () => [...assistantKeys.all, "weeklyReviews"] as const,
    weeklyReviewList: (userId: string) => [...assistantKeys.weeklyReviews(), "list", userId] as const,
    currentWeekReview: (userId: string) => [...assistantKeys.weeklyReviews(), "current", userId] as const,

    // Celebrations
    celebrations: () => [...assistantKeys.all, "celebrations"] as const,
    celebrationList: (userId: string) => [...assistantKeys.celebrations(), "list", userId] as const,
};

// ============================================
// Query Options (shared config)
// ============================================

const queryConfig = {
    staleTime: 30_000, // 30 seconds
    refetchOnWindowFocus: true,
};

// ============================================
// Tasks Queries
// ============================================

export function useAssistantTasksQuery(userId: string | null) {
    return useQuery({
        queryKey: assistantKeys.taskList(userId ?? ""),
        queryFn: () => getAssistantTasks({ data: { userId: userId! } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useAssistantTaskQuery(id: string | null) {
    return useQuery({
        queryKey: assistantKeys.taskDetail(id ?? ""),
        queryFn: () => getAssistantTask({ data: { id: id! } }),
        enabled: !!id,
        ...queryConfig,
    });
}

export function useCreateAssistantTaskMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantTask) => createAssistantTask({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.taskList(variables.userId),
            });
        },
    });
}

export function useUpdateAssistantTaskMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, data }: { id: string; data: Partial<NewAssistantTask> }) =>
            updateAssistantTask({ data: { id, data } }),
        onSuccess: (result) => {
            if (result) {
                queryClient.setQueryData(assistantKeys.taskDetail(result.id), result);
                queryClient.invalidateQueries({
                    queryKey: assistantKeys.taskList(result.userId),
                });
            }
        },
    });
}

export function useDeleteAssistantTaskMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, userId }: { id: string; userId: string }) => deleteAssistantTask({ data: { id } }),
        onSuccess: (_, { userId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.taskList(userId),
            });
        },
    });
}

// ============================================
// Context Parking Queries
// ============================================

export function useAssistantContextParkingsQuery(userId: string | null) {
    return useQuery({
        queryKey: assistantKeys.parkingList(userId ?? ""),
        queryFn: () => getAssistantContextParkings({ data: { userId: userId! } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateAssistantContextParkingMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantContextParking) => createAssistantContextParking({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.parkingList(variables.userId),
            });
        },
    });
}

export function useUpdateAssistantContextParkingMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, data, userId }: { id: string; data: Partial<NewAssistantContextParking>; userId: string }) =>
            updateAssistantContextParking({ data: { id, data } }),
        onSuccess: (_, { userId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.parkingList(userId),
            });
        },
    });
}

// ============================================
// Completions Queries
// ============================================

export function useAssistantCompletionsQuery(userId: string | null, limit?: number) {
    return useQuery({
        queryKey: assistantKeys.completionList(userId ?? ""),
        queryFn: () => getAssistantCompletions({ data: { userId: userId!, limit } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateAssistantCompletionMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantCompletion) => createAssistantCompletion({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.completionList(variables.userId),
            });
        },
    });
}

// ============================================
// Streaks Queries
// ============================================

export function useAssistantStreakQuery(userId: string | null) {
    return useQuery({
        queryKey: assistantKeys.streak(userId ?? ""),
        queryFn: () => getAssistantStreak({ data: { userId: userId! } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useUpsertAssistantStreakMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantStreak) => upsertAssistantStreak({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.streak(variables.userId),
            });
        },
    });
}

// ============================================
// Badges Queries
// ============================================

export function useAssistantBadgesQuery(userId: string | null) {
    return useQuery({
        queryKey: assistantKeys.badgeList(userId ?? ""),
        queryFn: () => getAssistantBadges({ data: { userId: userId! } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateAssistantBadgeMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantBadge) => createAssistantBadge({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.badgeList(variables.userId),
            });
        },
    });
}

// ============================================
// Communications Queries
// ============================================

export function useAssistantCommunicationsQuery(userId: string | null, limit?: number) {
    return useQuery({
        queryKey: assistantKeys.communicationList(userId ?? ""),
        queryFn: () => getAssistantCommunications({ data: { userId: userId!, limit } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateAssistantCommunicationMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantCommunication) => createAssistantCommunication({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.communicationList(variables.userId),
            });
        },
    });
}

export function useUpdateAssistantCommunicationMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, data, userId }: { id: string; data: Partial<NewAssistantCommunication>; userId: string }) =>
            updateAssistantCommunication({ data: { id, data } }),
        onSuccess: (_, { userId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.communicationList(userId),
            });
        },
    });
}

export function useDeleteAssistantCommunicationMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, userId }: { id: string; userId: string }) => deleteAssistantCommunication({ data: { id } }),
        onSuccess: (_, { userId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.communicationList(userId),
            });
        },
    });
}

// ============================================
// Decisions Queries
// ============================================

export function useAssistantDecisionsQuery(userId: string | null, limit?: number) {
    return useQuery({
        queryKey: assistantKeys.decisionList(userId ?? ""),
        queryFn: () => getAssistantDecisions({ data: { userId: userId!, limit } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateAssistantDecisionMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantDecision) => createAssistantDecision({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.decisionList(variables.userId),
            });
        },
    });
}

export function useUpdateAssistantDecisionMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, data, userId }: { id: string; data: Partial<NewAssistantDecision>; userId: string }) =>
            updateAssistantDecision({ data: { id, data } }),
        onSuccess: (_, { userId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.decisionList(userId),
            });
        },
    });
}

export function useDeleteAssistantDecisionMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, userId }: { id: string; userId: string }) => deleteAssistantDecision({ data: { id } }),
        onSuccess: (_, { userId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.decisionList(userId),
            });
        },
    });
}

// ============================================
// Blockers Queries
// ============================================

export function useAssistantBlockersQuery(userId: string | null, activeOnly?: boolean) {
    return useQuery({
        queryKey: assistantKeys.blockerList(userId ?? ""),
        queryFn: () => getAssistantBlockers({ data: { userId: userId!, activeOnly } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useAssistantBlockersByTaskQuery(taskId: string | null) {
    return useQuery({
        queryKey: assistantKeys.blockersByTask(taskId ?? ""),
        queryFn: () => getAssistantBlockersByTask({ data: { taskId: taskId! } }),
        enabled: !!taskId,
        ...queryConfig,
    });
}

export function useCreateAssistantBlockerMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantBlocker) => createAssistantBlocker({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.blockerList(variables.userId),
            });
            queryClient.invalidateQueries({
                queryKey: assistantKeys.blockersByTask(variables.taskId),
            });
        },
    });
}

export function useUpdateAssistantBlockerMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            id,
            data,
            userId,
            taskId,
        }: {
            id: string;
            data: Partial<NewAssistantBlocker>;
            userId: string;
            taskId: string;
        }) => updateAssistantBlocker({ data: { id, data } }),
        onSuccess: (_, { userId, taskId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.blockerList(userId),
            });
            queryClient.invalidateQueries({
                queryKey: assistantKeys.blockersByTask(taskId),
            });
        },
    });
}

export function useResolveAssistantBlockerMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, userId, taskId }: { id: string; userId: string; taskId: string }) =>
            resolveAssistantBlocker({ data: { id } }),
        onSuccess: (_, { userId, taskId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.blockerList(userId),
            });
            queryClient.invalidateQueries({
                queryKey: assistantKeys.blockersByTask(taskId),
            });
        },
    });
}

// ============================================
// Handoffs Queries
// ============================================

export function useAssistantHandoffsQuery(userId: string | null, limit?: number) {
    return useQuery({
        queryKey: assistantKeys.handoffList(userId ?? ""),
        queryFn: () => getAssistantHandoffs({ data: { userId: userId!, limit } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useAssistantHandoffsByTaskQuery(taskId: string | null) {
    return useQuery({
        queryKey: assistantKeys.handoffsByTask(taskId ?? ""),
        queryFn: () => getAssistantHandoffsByTask({ data: { taskId: taskId! } }),
        enabled: !!taskId,
        ...queryConfig,
    });
}

export function useCreateAssistantHandoffMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantHandoff) => createAssistantHandoff({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.handoffList(variables.userId),
            });
            queryClient.invalidateQueries({
                queryKey: assistantKeys.handoffsByTask(variables.taskId),
            });
        },
    });
}

export function useUpdateAssistantHandoffMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            id,
            data,
            userId,
            taskId,
        }: {
            id: string;
            data: Partial<NewAssistantHandoff>;
            userId: string;
            taskId: string;
        }) => updateAssistantHandoff({ data: { id, data } }),
        onSuccess: (_, { userId, taskId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.handoffList(userId),
            });
            queryClient.invalidateQueries({
                queryKey: assistantKeys.handoffsByTask(taskId),
            });
        },
    });
}

// ============================================
// Deadline Risks Queries
// ============================================

export function useAssistantDeadlineRisksQuery(userId: string | null) {
    return useQuery({
        queryKey: assistantKeys.deadlineRiskList(userId ?? ""),
        queryFn: () => getAssistantDeadlineRisks({ data: { userId: userId! } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useAssistantDeadlineRiskByTaskQuery(taskId: string | null) {
    return useQuery({
        queryKey: assistantKeys.deadlineRiskByTask(taskId ?? ""),
        queryFn: () => getAssistantDeadlineRiskByTask({ data: { taskId: taskId! } }),
        enabled: !!taskId,
        ...queryConfig,
    });
}

export function useCreateAssistantDeadlineRiskMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantDeadlineRisk) => createAssistantDeadlineRisk({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.deadlineRiskList(variables.userId),
            });
            queryClient.invalidateQueries({
                queryKey: assistantKeys.deadlineRiskByTask(variables.taskId),
            });
        },
    });
}

// ============================================
// Energy Snapshots Queries
// ============================================

export function useAssistantEnergySnapshotsQuery(userId: string | null, limit?: number) {
    return useQuery({
        queryKey: assistantKeys.energySnapshotList(userId ?? ""),
        queryFn: () => getAssistantEnergySnapshots({ data: { userId: userId!, limit } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateAssistantEnergySnapshotMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantEnergySnapshot) => createAssistantEnergySnapshot({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.energySnapshotList(variables.userId),
            });
        },
    });
}

// ============================================
// Distractions Queries
// ============================================

export function useAssistantDistractionsQuery(userId: string | null, limit?: number) {
    return useQuery({
        queryKey: assistantKeys.distractionList(userId ?? ""),
        queryFn: () => getAssistantDistractions({ data: { userId: userId!, limit } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateAssistantDistractionMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantDistraction) => createAssistantDistraction({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.distractionList(variables.userId),
            });
        },
    });
}

// ============================================
// Weekly Reviews Queries
// ============================================

export function useAssistantWeeklyReviewsQuery(userId: string | null, limit?: number) {
    return useQuery({
        queryKey: assistantKeys.weeklyReviewList(userId ?? ""),
        queryFn: () => getAssistantWeeklyReviews({ data: { userId: userId!, limit } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useAssistantCurrentWeekReviewQuery(userId: string | null) {
    return useQuery({
        queryKey: assistantKeys.currentWeekReview(userId ?? ""),
        queryFn: () => getAssistantCurrentWeekReview({ data: { userId: userId! } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateAssistantWeeklyReviewMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantWeeklyReview) => createAssistantWeeklyReview({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.weeklyReviewList(variables.userId),
            });
            queryClient.invalidateQueries({
                queryKey: assistantKeys.currentWeekReview(variables.userId),
            });
        },
    });
}

// ============================================
// Celebrations Queries
// ============================================

export function useAssistantCelebrationsQuery(userId: string | null, unshownOnly?: boolean) {
    return useQuery({
        queryKey: assistantKeys.celebrationList(userId ?? ""),
        queryFn: () => getAssistantCelebrations({ data: { userId: userId!, unshownOnly } }),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateAssistantCelebrationMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewAssistantCelebration) => createAssistantCelebration({ data }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.celebrationList(variables.userId),
            });
        },
    });
}

export function useMarkAssistantCelebrationShownMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, userId }: { id: string; userId: string }) => markAssistantCelebrationShown({ data: { id } }),
        onSuccess: (_, { userId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.celebrationList(userId),
            });
        },
    });
}

export function useDismissAssistantCelebrationMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, userId }: { id: string; userId: string }) => dismissAssistantCelebration({ data: { id } }),
        onSuccess: (_, { userId }) => {
            queryClient.invalidateQueries({
                queryKey: assistantKeys.celebrationList(userId),
            });
        },
    });
}
