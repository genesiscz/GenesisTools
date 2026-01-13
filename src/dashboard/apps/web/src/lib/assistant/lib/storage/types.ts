import type {
  Task,
  TaskInput,
  TaskUpdate,
  ContextParking,
  ContextParkingInput,
  CompletionEvent,
  CompletionEventInput,
  Streak,
  Badge,
  // Phase 2 types
  CommunicationEntry,
  CommunicationEntryInput,
  CommunicationEntryUpdate,
  Decision,
  DecisionInput,
  DecisionUpdate,
  TaskBlocker,
  TaskBlockerInput,
  TaskBlockerUpdate,
  HandoffDocument,
  HandoffDocumentInput,
  HandoffDocumentUpdate,
  DeadlineRisk,
  DeadlineRiskInput,
  // Phase 3 types
  EnergySnapshot,
  EnergySnapshotInput,
  Distraction,
  DistractionInput,
  WeeklyReview,
  WeeklyReviewInput,
  Celebration,
  BadgeProgress,
  CelebrationTier,
} from '@/lib/assistant/types'

/**
 * Storage adapter interface for Assistant module
 */
export interface AssistantStorageAdapter {
  // ============================================
  // Task CRUD operations
  // ============================================
  getTasks(userId: string): Promise<Task[]>
  getTask(id: string): Promise<Task | null>
  createTask(input: TaskInput, userId: string): Promise<Task>
  updateTask(id: string, updates: TaskUpdate): Promise<Task>
  deleteTask(id: string): Promise<void>

  // ============================================
  // Context Parking operations
  // ============================================
  getParkingHistory(userId: string, taskId?: string): Promise<ContextParking[]>
  getActiveParking(taskId: string): Promise<ContextParking | null>
  parkContext(input: ContextParkingInput, userId: string): Promise<ContextParking>
  resumeParking(parkingId: string): Promise<ContextParking>
  archiveParking(parkingId: string): Promise<void>

  // ============================================
  // Completion & Celebration operations
  // ============================================
  logCompletion(input: CompletionEventInput, userId: string): Promise<CompletionEvent>
  getCompletions(userId: string, options?: CompletionQueryOptions): Promise<CompletionEvent[]>
  getCompletionStats(userId: string): Promise<CompletionStats>

  // ============================================
  // Streak operations
  // ============================================
  getStreak(userId: string): Promise<Streak | null>
  updateStreak(userId: string): Promise<Streak>
  resetStreak(userId: string): Promise<Streak>

  // ============================================
  // Badge operations
  // ============================================
  getBadges(userId: string): Promise<Badge[]>
  awardBadge(userId: string, badgeType: string): Promise<Badge>
  checkBadgeEligibility(userId: string): Promise<string[]> // Returns badge types to award

  // ============================================
  // Communication Log operations (Phase 2)
  // ============================================
  getCommunicationEntries(userId: string, options?: CommunicationQueryOptions): Promise<CommunicationEntry[]>
  getCommunicationEntry(id: string): Promise<CommunicationEntry | null>
  createCommunicationEntry(input: CommunicationEntryInput, userId: string): Promise<CommunicationEntry>
  updateCommunicationEntry(id: string, updates: CommunicationEntryUpdate): Promise<CommunicationEntry>
  deleteCommunicationEntry(id: string): Promise<void>

  // ============================================
  // Decision Log operations (Phase 2)
  // ============================================
  getDecisions(userId: string, options?: DecisionQueryOptions): Promise<Decision[]>
  getDecision(id: string): Promise<Decision | null>
  createDecision(input: DecisionInput, userId: string): Promise<Decision>
  updateDecision(id: string, updates: DecisionUpdate): Promise<Decision>
  deleteDecision(id: string): Promise<void>
  supersedeDecision(id: string, newDecisionId: string): Promise<Decision>
  reverseDecision(id: string, reason: string): Promise<Decision>

  // ============================================
  // Task Blocker operations (Phase 2)
  // ============================================
  getBlockers(userId: string, taskId?: string): Promise<TaskBlocker[]>
  getActiveBlocker(taskId: string): Promise<TaskBlocker | null>
  createBlocker(input: TaskBlockerInput, userId: string): Promise<TaskBlocker>
  updateBlocker(id: string, updates: TaskBlockerUpdate): Promise<TaskBlocker>
  resolveBlocker(id: string): Promise<TaskBlocker>
  deleteBlocker(id: string): Promise<void>

  // ============================================
  // Handoff Document operations (Phase 2)
  // ============================================
  getHandoffs(userId: string, taskId?: string): Promise<HandoffDocument[]>
  getHandoff(id: string): Promise<HandoffDocument | null>
  createHandoff(input: HandoffDocumentInput, userId: string): Promise<HandoffDocument>
  updateHandoff(id: string, updates: HandoffDocumentUpdate): Promise<HandoffDocument>
  acknowledgeHandoff(id: string): Promise<HandoffDocument>
  deleteHandoff(id: string): Promise<void>

  // ============================================
  // Deadline Risk operations (Phase 2)
  // ============================================
  getDeadlineRisks(userId: string): Promise<DeadlineRisk[]>
  calculateDeadlineRisk(input: DeadlineRiskInput, userId: string): Promise<DeadlineRisk>
  getDeadlineRiskForTask(taskId: string): Promise<DeadlineRisk | null>

  // ============================================
  // Energy Snapshot operations (Phase 3)
  // ============================================
  getEnergySnapshots(userId: string, options?: EnergyQueryOptions): Promise<EnergySnapshot[]>
  logEnergySnapshot(input: EnergySnapshotInput, userId: string): Promise<EnergySnapshot>
  getEnergyHeatmapData(userId: string, startDate: Date, endDate: Date): Promise<EnergyHeatmapData>

  // ============================================
  // Distraction operations (Phase 3)
  // ============================================
  getDistractions(userId: string, options?: DistractionQueryOptions): Promise<Distraction[]>
  logDistraction(input: DistractionInput, userId: string): Promise<Distraction>
  getDistractionStats(userId: string, startDate: Date, endDate: Date): Promise<DistractionStats>

  // ============================================
  // Weekly Review operations (Phase 3)
  // ============================================
  getWeeklyReviews(userId: string, limit?: number): Promise<WeeklyReview[]>
  getWeeklyReview(id: string): Promise<WeeklyReview | null>
  generateWeeklyReview(input: WeeklyReviewInput, userId: string): Promise<WeeklyReview>
  getCurrentWeekReview(userId: string): Promise<WeeklyReview | null>

  // ============================================
  // Celebration operations (Phase 3)
  // ============================================
  getPendingCelebrations(userId: string): Promise<Celebration[]>
  createCelebration(userId: string, tier: CelebrationTier, title: string, message: string, triggerType: string, triggerId?: string): Promise<Celebration>
  markCelebrationShown(id: string): Promise<Celebration>
  dismissCelebration(id: string): Promise<void>
  determineCelebrationTier(userId: string, completionType: string): Promise<CelebrationTier>

  // ============================================
  // Badge Progress operations (Phase 3)
  // ============================================
  getBadgeProgress(userId: string): Promise<BadgeProgress[]>

  // ============================================
  // Real-time subscriptions
  // ============================================
  watchTasks(userId: string, callback: (tasks: Task[]) => void): () => void
  watchStreak(userId: string, callback: (streak: Streak | null) => void): () => void
  watchBadges(userId: string, callback: (badges: Badge[]) => void): () => void
  watchCommunications(userId: string, callback: (entries: CommunicationEntry[]) => void): () => void
  watchDecisions(userId: string, callback: (decisions: Decision[]) => void): () => void
  watchBlockers(userId: string, callback: (blockers: TaskBlocker[]) => void): () => void
  watchCelebrations(userId: string, callback: (celebrations: Celebration[]) => void): () => void

  // ============================================
  // Initialization
  // ============================================
  initialize(): Promise<void>
  isInitialized(): boolean
}

/**
 * Query options for completions
 */
export interface CompletionQueryOptions {
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}

/**
 * Query options for communication entries
 */
export interface CommunicationQueryOptions {
  source?: string
  sentiment?: string
  tags?: string[]
  relatedTaskId?: string
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}

/**
 * Query options for decisions
 */
export interface DecisionQueryOptions {
  status?: string
  impactArea?: string
  tags?: string[]
  relatedTaskId?: string
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}

/**
 * Query options for energy snapshots
 */
export interface EnergyQueryOptions {
  startDate?: Date
  endDate?: Date
  workType?: string
  limit?: number
  offset?: number
}

/**
 * Query options for distractions
 */
export interface DistractionQueryOptions {
  source?: string
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}

/**
 * Aggregated completion statistics
 */
export interface CompletionStats {
  totalTasksCompleted: number
  totalFocusTime: number // minutes
  tasksCompletedThisWeek: number
  tasksCompletedToday: number
  criticalTasksCompleted: number
  currentStreak: number
  longestStreak: number
}

/**
 * Energy heatmap data for visualization
 */
export interface EnergyHeatmapData {
  /** Data points by day and hour */
  cells: Array<{
    date: string // YYYY-MM-DD
    hour: number // 0-23
    focusQuality: number // Average focus quality
    count: number // Number of snapshots
  }>
  /** Average focus quality by hour of day */
  hourlyAverages: Record<number, number>
  /** Average focus quality by day of week (0=Sunday) */
  dailyAverages: Record<number, number>
  /** Peak focus time */
  peakTime: { hour: number; day: number; quality: number }
  /** Low energy time */
  lowTime: { hour: number; day: number; quality: number }
}

/**
 * Distraction statistics
 */
export interface DistractionStats {
  totalDistractions: number
  totalDurationMinutes: number
  bySource: Record<string, { count: number; duration: number }>
  averagePerDay: number
  resumptionRate: number // Percentage that resumed task
  mostCommonSource: string
  mostDisruptiveSource: string // By duration
}

/**
 * Cross-tab sync message types
 */
export type AssistantSyncMessageType =
  | 'TASK_CREATED'
  | 'TASK_UPDATED'
  | 'TASK_DELETED'
  | 'CONTEXT_PARKED'
  | 'CONTEXT_RESUMED'
  | 'COMPLETION_LOGGED'
  | 'STREAK_UPDATED'
  | 'BADGE_EARNED'
  // Phase 2 messages
  | 'COMMUNICATION_CREATED'
  | 'COMMUNICATION_UPDATED'
  | 'COMMUNICATION_DELETED'
  | 'DECISION_CREATED'
  | 'DECISION_UPDATED'
  | 'DECISION_DELETED'
  | 'BLOCKER_CREATED'
  | 'BLOCKER_UPDATED'
  | 'BLOCKER_RESOLVED'
  | 'HANDOFF_CREATED'
  | 'HANDOFF_ACKNOWLEDGED'
  // Phase 3 messages
  | 'ENERGY_LOGGED'
  | 'DISTRACTION_LOGGED'
  | 'WEEKLY_REVIEW_GENERATED'
  | 'CELEBRATION_CREATED'
  | 'CELEBRATION_DISMISSED'

export interface AssistantSyncMessage {
  type: AssistantSyncMessageType
  payload: unknown
  timestamp: number
  sourceTab: string
}
