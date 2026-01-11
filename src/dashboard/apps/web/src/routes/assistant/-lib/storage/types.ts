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
} from '../../-types'

/**
 * Storage adapter interface for Assistant module
 */
export interface AssistantStorageAdapter {
  // Task CRUD operations
  getTasks(userId: string): Promise<Task[]>
  getTask(id: string): Promise<Task | null>
  createTask(input: TaskInput, userId: string): Promise<Task>
  updateTask(id: string, updates: TaskUpdate): Promise<Task>
  deleteTask(id: string): Promise<void>

  // Context Parking operations
  getParkingHistory(userId: string, taskId?: string): Promise<ContextParking[]>
  getActiveParking(taskId: string): Promise<ContextParking | null>
  parkContext(input: ContextParkingInput, userId: string): Promise<ContextParking>
  resumeParking(parkingId: string): Promise<ContextParking>
  archiveParking(parkingId: string): Promise<void>

  // Completion & Celebration operations
  logCompletion(input: CompletionEventInput, userId: string): Promise<CompletionEvent>
  getCompletions(userId: string, options?: CompletionQueryOptions): Promise<CompletionEvent[]>
  getCompletionStats(userId: string): Promise<CompletionStats>

  // Streak operations
  getStreak(userId: string): Promise<Streak | null>
  updateStreak(userId: string): Promise<Streak>
  resetStreak(userId: string): Promise<Streak>

  // Badge operations
  getBadges(userId: string): Promise<Badge[]>
  awardBadge(userId: string, badgeType: string): Promise<Badge>
  checkBadgeEligibility(userId: string): Promise<string[]> // Returns badge types to award

  // Real-time subscriptions
  watchTasks(userId: string, callback: (tasks: Task[]) => void): () => void
  watchStreak(userId: string, callback: (streak: Streak | null) => void): () => void
  watchBadges(userId: string, callback: (badges: Badge[]) => void): () => void

  // Initialization
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

export interface AssistantSyncMessage {
  type: AssistantSyncMessageType
  payload: unknown
  timestamp: number
  sourceTab: string
}
