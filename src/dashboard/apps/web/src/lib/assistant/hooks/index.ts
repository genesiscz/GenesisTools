// Core Phase 1 hooks (localStorage)

export { useBadgeProgress } from "./useBadgeProgress";
export { blockersStore, useBlockers } from "./useBlockers";
export { useCelebrations } from "./useCelebrations";

// Phase 2 hooks (localStorage)
export { communicationStore, useCommunicationLog } from "./useCommunicationLog";
export { useContextParking } from "./useContextParking";
export { useDeadlineRisk } from "./useDeadlineRisk";
export { decisionStore, useDecisionLog } from "./useDecisionLog";
export { useDistractions } from "./useDistractions";

// Phase 3 hooks (localStorage)
export { useEnergyData } from "./useEnergyData";
export { useHandoff } from "./useHandoff";
export { useStreak } from "./useStreak";
export { taskStore, useTaskStore } from "./useTaskStore";
export { useWeeklyReview } from "./useWeeklyReview";

// ============================================
// Server-first TanStack Query hooks
// ============================================
// These hooks use Drizzle/Neon with refetchOnWindowFocus.
// Gradually migrate components to use these for database persistence.

export {
    // Query keys for cache management
    assistantKeys,
    // Badges
    useAssistantBadgesQuery,
    useAssistantBlockersByTaskQuery,
    // Blockers
    useAssistantBlockersQuery,
    // Celebrations
    useAssistantCelebrationsQuery,
    // Communications
    useAssistantCommunicationsQuery,
    // Completions
    useAssistantCompletionsQuery,
    // Context Parking
    useAssistantContextParkingsQuery,
    useAssistantCurrentWeekReviewQuery,
    useAssistantDeadlineRiskByTaskQuery,
    // Deadline Risks
    useAssistantDeadlineRisksQuery,
    // Decisions
    useAssistantDecisionsQuery,
    // Distractions
    useAssistantDistractionsQuery,
    // Energy Snapshots
    useAssistantEnergySnapshotsQuery,
    useAssistantHandoffsByTaskQuery,
    // Handoffs
    useAssistantHandoffsQuery,
    // Streaks
    useAssistantStreakQuery,
    useAssistantTaskQuery,
    // Tasks
    useAssistantTasksQuery,
    // Weekly Reviews
    useAssistantWeeklyReviewsQuery,
    useCreateAssistantBadgeMutation,
    useCreateAssistantBlockerMutation,
    useCreateAssistantCelebrationMutation,
    useCreateAssistantCommunicationMutation,
    useCreateAssistantCompletionMutation,
    useCreateAssistantContextParkingMutation,
    useCreateAssistantDeadlineRiskMutation,
    useCreateAssistantDecisionMutation,
    useCreateAssistantDistractionMutation,
    useCreateAssistantEnergySnapshotMutation,
    useCreateAssistantHandoffMutation,
    useCreateAssistantTaskMutation,
    useCreateAssistantWeeklyReviewMutation,
    useDeleteAssistantCommunicationMutation,
    useDeleteAssistantDecisionMutation,
    useDeleteAssistantTaskMutation,
    useDismissAssistantCelebrationMutation,
    useMarkAssistantCelebrationShownMutation,
    useResolveAssistantBlockerMutation,
    useUpdateAssistantBlockerMutation,
    useUpdateAssistantCommunicationMutation,
    useUpdateAssistantContextParkingMutation,
    useUpdateAssistantDecisionMutation,
    useUpdateAssistantHandoffMutation,
    useUpdateAssistantTaskMutation,
    useUpsertAssistantStreakMutation,
} from "./useAssistantQueries";
