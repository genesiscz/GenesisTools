// Core Phase 1 hooks (localStorage)
export { useTaskStore, taskStore } from './useTaskStore'
export { useContextParking } from './useContextParking'
export { useStreak } from './useStreak'

// Phase 2 hooks (localStorage)
export { useCommunicationLog, communicationStore } from './useCommunicationLog'
export { useDecisionLog, decisionStore } from './useDecisionLog'
export { useBlockers, blockersStore } from './useBlockers'
export { useHandoff } from './useHandoff'
export { useDeadlineRisk } from './useDeadlineRisk'

// Phase 3 hooks (localStorage)
export { useEnergyData } from './useEnergyData'
export { useDistractions } from './useDistractions'
export { useWeeklyReview } from './useWeeklyReview'
export { useCelebrations } from './useCelebrations'
export { useBadgeProgress } from './useBadgeProgress'

// ============================================
// Server-first TanStack Query hooks
// ============================================
// These hooks use Drizzle/Neon with refetchOnWindowFocus.
// Gradually migrate components to use these for database persistence.

export {
  // Query keys for cache management
  assistantKeys,
  // Tasks
  useAssistantTasksQuery,
  useAssistantTaskQuery,
  useCreateAssistantTaskMutation,
  useUpdateAssistantTaskMutation,
  useDeleteAssistantTaskMutation,
  // Context Parking
  useAssistantContextParkingsQuery,
  useCreateAssistantContextParkingMutation,
  useUpdateAssistantContextParkingMutation,
  // Completions
  useAssistantCompletionsQuery,
  useCreateAssistantCompletionMutation,
  // Streaks
  useAssistantStreakQuery,
  useUpsertAssistantStreakMutation,
  // Badges
  useAssistantBadgesQuery,
  useCreateAssistantBadgeMutation,
  // Communications
  useAssistantCommunicationsQuery,
  useCreateAssistantCommunicationMutation,
  useUpdateAssistantCommunicationMutation,
  useDeleteAssistantCommunicationMutation,
  // Decisions
  useAssistantDecisionsQuery,
  useCreateAssistantDecisionMutation,
  useUpdateAssistantDecisionMutation,
  useDeleteAssistantDecisionMutation,
  // Blockers
  useAssistantBlockersQuery,
  useAssistantBlockersByTaskQuery,
  useCreateAssistantBlockerMutation,
  useUpdateAssistantBlockerMutation,
  useResolveAssistantBlockerMutation,
  // Handoffs
  useAssistantHandoffsQuery,
  useAssistantHandoffsByTaskQuery,
  useCreateAssistantHandoffMutation,
  useUpdateAssistantHandoffMutation,
  // Deadline Risks
  useAssistantDeadlineRisksQuery,
  useAssistantDeadlineRiskByTaskQuery,
  useCreateAssistantDeadlineRiskMutation,
  // Energy Snapshots
  useAssistantEnergySnapshotsQuery,
  useCreateAssistantEnergySnapshotMutation,
  // Distractions
  useAssistantDistractionsQuery,
  useCreateAssistantDistractionMutation,
  // Weekly Reviews
  useAssistantWeeklyReviewsQuery,
  useAssistantCurrentWeekReviewQuery,
  useCreateAssistantWeeklyReviewMutation,
  // Celebrations
  useAssistantCelebrationsQuery,
  useCreateAssistantCelebrationMutation,
  useMarkAssistantCelebrationShownMutation,
  useDismissAssistantCelebrationMutation,
} from './useAssistantQueries'
