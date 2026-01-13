/**
 * Assistant module types
 *
 * Core data models for the Personal AI Assistant:
 * - Task management with deadline hierarchy
 * - Context parking for preserving working memory
 * - Completion celebrations and streaks for ADHD motivation
 * - Communication and decision logging (Phase 2)
 * - Energy tracking and analytics (Phase 3)
 */

// ============================================
// Urgency & Status Enums
// ============================================

/**
 * Task urgency levels with visual color mapping:
 * - critical (red): Blocks shipping, customer impact
 * - important (orange): Should hit deadline, causes downstream issues
 * - nice-to-have (yellow): Flexible deadline, minimal impact if missed
 */
export type UrgencyLevel = 'critical' | 'important' | 'nice-to-have'

/**
 * Task status workflow:
 * - backlog: Not started
 * - in-progress: Actively working
 * - blocked: Waiting on dependency
 * - completed: Done
 */
export type TaskStatus = 'backlog' | 'in-progress' | 'blocked' | 'completed'

/**
 * Context parking status:
 * - active: Currently parked, awaiting resume
 * - resumed: User resumed work
 * - archived: Old/cleared parking
 */
export type ParkingStatus = 'active' | 'resumed' | 'archived'

/**
 * Badge rarity tiers
 */
export type BadgeRarity = 'common' | 'uncommon' | 'rare' | 'legendary'

/**
 * Badge types for unlockable achievements
 */
export type BadgeType =
  | 'task-master-10'
  | 'task-master-50'
  | 'task-master-100'
  | 'streak-3'
  | 'streak-7'
  | 'streak-14'
  | 'streak-30'
  | 'first-task'
  | 'first-critical'
  | 'context-keeper'
  | 'focus-warrior'
  | 'decision-maker'
  | 'communicator'
  | 'deep-worker'

/**
 * Completion event types for celebrations
 */
export type CompletionType =
  | 'task-complete'
  | 'focus-session'
  | 'streak-milestone'
  | 'badge-earned'

// ============================================
// Task Data Model
// ============================================

/**
 * Core Task entity
 * Represents a work item with deadline hierarchy and context tracking
 */
export interface Task {
  id: string
  userId: string
  title: string
  description: string
  projectId?: string

  // Deadline hierarchy
  deadline?: Date
  urgencyLevel: UrgencyLevel
  isShippingBlocker: boolean

  // Context management
  contextParkingLot?: string // Last parked context
  linkedGitHub?: string // PR/issue URL

  // Dependencies (Phase 2)
  blockedBy?: string[] // taskIds
  blocks?: string[] // taskIds

  // Status & tracking
  status: TaskStatus
  completedAt?: Date
  focusTimeLogged: number // minutes

  // Timestamps
  createdAt: Date
  updatedAt: Date
}

/**
 * Input for creating a new task
 */
export interface TaskInput {
  title: string
  description?: string
  projectId?: string
  deadline?: Date
  urgencyLevel?: UrgencyLevel
  isShippingBlocker?: boolean
  linkedGitHub?: string
  status?: TaskStatus
}

/**
 * Partial update for existing task
 */
export interface TaskUpdate {
  title?: string
  description?: string
  projectId?: string
  deadline?: Date
  urgencyLevel?: UrgencyLevel
  isShippingBlocker?: boolean
  contextParkingLot?: string
  linkedGitHub?: string
  blockedBy?: string[]
  blocks?: string[]
  status?: TaskStatus
  completedAt?: Date
  focusTimeLogged?: number
}

// ============================================
// Context Parking Data Model
// ============================================

/**
 * Context Parking entry
 * Captures working memory when switching tasks
 */
export interface ContextParking {
  id: string
  userId: string
  taskId: string
  content: string // User's notes on where they left off

  // Optional code context
  codeContext?: {
    filePath?: string
    lineNumber?: number
    snippet?: string
  }

  discoveryNotes?: string // What they found/learned
  nextSteps?: string // What to do when resuming

  // Timestamps
  parkedAt: Date
  resumedAt?: Date
  createdAt: Date

  status: ParkingStatus
}

/**
 * Input for parking context
 */
export interface ContextParkingInput {
  taskId: string
  content: string
  codeContext?: {
    filePath?: string
    lineNumber?: number
    snippet?: string
  }
  discoveryNotes?: string
  nextSteps?: string
}

// ============================================
// Completion & Celebration Data Models
// ============================================

/**
 * Completion event for celebration tracking
 */
export interface CompletionEvent {
  id: string
  userId: string
  taskId: string
  completionType: CompletionType
  completedAt: Date
  celebrationShown: boolean

  metadata: {
    focusTimeSpent?: number // minutes
    taskUrgency?: UrgencyLevel
    currentStreak?: number // days
    totalTasksCompleted?: number
    badgeName?: string
  }
}

/**
 * Input for logging completion
 */
export interface CompletionEventInput {
  taskId: string
  completionType: CompletionType
  metadata?: CompletionEvent['metadata']
}

// ============================================
// Streak Data Model
// ============================================

/**
 * User's streak tracking
 */
export interface Streak {
  userId: string
  currentStreakDays: number
  longestStreakDays: number
  lastTaskCompletionDate: Date
  streakResetDate?: Date // When current streak started
}

// ============================================
// Badge Data Model
// ============================================

/**
 * Badge definition (static)
 */
export interface BadgeDefinition {
  type: BadgeType
  displayName: string
  description: string
  icon: string // Lucide icon name
  rarity: BadgeRarity
  requirement: {
    type: 'task-count' | 'streak-days' | 'first-action' | 'focus-time' | 'decision-count' | 'communication-count'
    value: number
    action?: string
  }
}

/**
 * User's earned badge
 */
export interface Badge {
  id: string
  userId: string
  badgeType: BadgeType
  earnedAt: Date
  displayName: string
  rarity: BadgeRarity
}

// ============================================
// Communication Log Data Model (Phase 2)
// ============================================

/**
 * Source of communication entry
 */
export type CommunicationSource = 'slack' | 'github' | 'email' | 'meeting' | 'manual'

/**
 * Sentiment/type of communication
 */
export type CommunicationSentiment = 'decision' | 'discussion' | 'blocker' | 'context'

/**
 * Communication Log entry
 * Captures important discussions, decisions, and context from various sources
 */
export interface CommunicationEntry {
  id: string
  userId: string
  source: CommunicationSource
  title: string
  content: string
  sourceUrl?: string
  discussedAt: Date
  tags: string[]
  relatedTaskIds: string[]
  sentiment: CommunicationSentiment
  createdAt: Date
  updatedAt: Date
}

/**
 * Input for creating a communication entry
 */
export interface CommunicationEntryInput {
  source: CommunicationSource
  title: string
  content: string
  sourceUrl?: string
  discussedAt?: Date
  tags?: string[]
  relatedTaskIds?: string[]
  sentiment?: CommunicationSentiment
}

/**
 * Partial update for communication entry
 */
export interface CommunicationEntryUpdate {
  title?: string
  content?: string
  sourceUrl?: string
  discussedAt?: Date
  tags?: string[]
  relatedTaskIds?: string[]
  sentiment?: CommunicationSentiment
}

// ============================================
// Decision Log Data Model (Phase 2)
// ============================================

/**
 * Status of a decision
 */
export type DecisionStatus = 'active' | 'superseded' | 'reversed'

/**
 * Impact area of a decision
 */
export type DecisionImpactArea = 'frontend' | 'backend' | 'infrastructure' | 'process' | 'architecture' | 'product'

/**
 * Decision Log entry
 * Records technical and process decisions with full context
 */
export interface Decision {
  id: string
  userId: string
  title: string
  reasoning: string
  alternativesConsidered: string[]
  decidedAt: Date
  decidedBy: string
  status: DecisionStatus
  supersededBy?: string // Decision ID
  reversalReason?: string
  impactArea: DecisionImpactArea
  relatedTaskIds: string[]
  tags: string[]
  createdAt: Date
  updatedAt: Date
}

/**
 * Input for creating a decision
 */
export interface DecisionInput {
  title: string
  reasoning: string
  alternativesConsidered?: string[]
  decidedAt?: Date
  decidedBy?: string
  impactArea: DecisionImpactArea
  relatedTaskIds?: string[]
  tags?: string[]
}

/**
 * Partial update for decision
 */
export interface DecisionUpdate {
  title?: string
  reasoning?: string
  alternativesConsidered?: string[]
  decidedAt?: Date
  decidedBy?: string
  status?: DecisionStatus
  supersededBy?: string
  reversalReason?: string
  impactArea?: DecisionImpactArea
  relatedTaskIds?: string[]
  tags?: string[]
}

// ============================================
// Task Blocker Data Model (Phase 2)
// ============================================

/**
 * Follow-up action for blockers
 */
export type BlockerFollowUpAction = 'remind' | 'switch' | 'wait'

/**
 * Task Blocker entry
 * Tracks why a task is blocked and when
 */
export interface TaskBlocker {
  id: string
  userId: string
  taskId: string
  reason: string
  blockedSince: Date
  blockerOwner?: string
  followUpAction?: BlockerFollowUpAction
  reminderSet?: Date
  unblockedAt?: Date
  createdAt: Date
  updatedAt: Date
}

/**
 * Input for creating a blocker
 */
export interface TaskBlockerInput {
  taskId: string
  reason: string
  blockerOwner?: string
  followUpAction?: BlockerFollowUpAction
  reminderSet?: Date
}

/**
 * Partial update for blocker
 */
export interface TaskBlockerUpdate {
  reason?: string
  blockerOwner?: string
  followUpAction?: BlockerFollowUpAction
  reminderSet?: Date
  unblockedAt?: Date
}

// ============================================
// Energy Tracking Data Model (Phase 3)
// ============================================

/**
 * Focus quality rating (1-5)
 */
export type FocusQuality = 1 | 2 | 3 | 4 | 5

/**
 * Type of work being done
 */
export type WorkType = 'deep-work' | 'communication' | 'admin' | 'meeting'

/**
 * Energy Snapshot
 * Captures energy and focus state at a point in time
 */
export interface EnergySnapshot {
  id: string
  userId: string
  timestamp: Date
  focusQuality: FocusQuality
  contextSwitches: number
  tasksCompleted: number
  typeOfWork: WorkType
  notes?: string
  createdAt: Date
}

/**
 * Input for logging an energy snapshot
 */
export interface EnergySnapshotInput {
  focusQuality: FocusQuality
  contextSwitches?: number
  tasksCompleted?: number
  typeOfWork: WorkType
  notes?: string
  timestamp?: Date
}

// ============================================
// Handoff Data Model (Phase 2)
// ============================================

/**
 * Handoff Document
 * Structured document for handing off work to another person or future self
 */
export interface HandoffDocument {
  id: string
  userId: string
  taskId: string
  handedOffFrom: string
  handedOffTo: string
  handoffAt: Date
  summary: string
  contextNotes: string
  decisions: string[] // Decision IDs
  blockers: string[] // Blocker IDs
  nextSteps: string[]
  gotchas?: string
  contact: string
  reviewed: boolean
  reviewedAt?: Date
  createdAt: Date
  updatedAt: Date
}

/**
 * Input for creating a handoff document
 */
export interface HandoffDocumentInput {
  taskId: string
  handedOffTo: string
  summary: string
  contextNotes: string
  decisions?: string[]
  blockers?: string[]
  nextSteps: string[]
  gotchas?: string
  contact: string
}

/**
 * Partial update for handoff document
 */
export interface HandoffDocumentUpdate {
  summary?: string
  contextNotes?: string
  decisions?: string[]
  blockers?: string[]
  nextSteps?: string[]
  gotchas?: string
  contact?: string
  reviewed?: boolean
  reviewedAt?: Date
}

// ============================================
// Deadline Risk Data Model (Phase 2)
// ============================================

/**
 * Risk level for deadline
 */
export type DeadlineRiskLevel = 'green' | 'yellow' | 'red'

/**
 * Recommended option for handling deadline risk
 */
export type DeadlineRiskOption = 'extend' | 'help' | 'scope' | 'accept'

/**
 * Deadline Risk assessment
 * Calculated risk assessment for a task's deadline
 */
export interface DeadlineRisk {
  id: string
  userId: string
  taskId: string
  riskLevel: DeadlineRiskLevel
  projectedCompletionDate: Date
  daysLate: number
  daysRemaining: number
  percentComplete: number
  recommendedOption: DeadlineRiskOption
  calculatedAt: Date
  createdAt: Date
}

/**
 * Input for deadline risk calculation
 */
export interface DeadlineRiskInput {
  taskId: string
  percentComplete?: number
  projectedCompletionDate?: Date
}

// ============================================
// Distraction Data Model (Phase 3)
// ============================================

/**
 * Source of distraction
 */
export type DistractionSource = 'slack' | 'email' | 'meeting' | 'coworker' | 'hunger' | 'other'

/**
 * Distraction entry
 * Tracks interruptions and their impact
 */
export interface Distraction {
  id: string
  userId: string
  timestamp: Date
  source: DistractionSource
  description?: string
  duration?: number // minutes
  taskInterrupted?: string // taskId
  resumedTask: boolean
  createdAt: Date
}

/**
 * Input for logging a distraction
 */
export interface DistractionInput {
  source: DistractionSource
  description?: string
  duration?: number
  taskInterrupted?: string
  resumedTask?: boolean
  timestamp?: Date
}

// ============================================
// Weekly Review Data Model (Phase 3)
// ============================================

/**
 * Weekly Review
 * Aggregated weekly analytics and insights
 */
export interface WeeklyReview {
  id: string
  userId: string
  weekStart: Date
  weekEnd: Date
  tasksCompleted: number
  tasksCompletedLastWeek: number
  deadlinesHit: number
  deadlinesTotal: number
  totalMinutes: number
  deepFocusMinutes: number
  meetingMinutes: number
  averageEnergy: number
  energyByDay: Record<string, number>
  peakFocusTime: string
  lowEnergyTime: string
  insights: string[]
  recommendations: string[]
  badgesEarned: string[]
  streakDays: number
  generatedAt: Date
  createdAt: Date
}

/**
 * Input for generating weekly review
 */
export interface WeeklyReviewInput {
  weekStart: Date
  weekEnd: Date
}

// ============================================
// Celebration Data Model (Phase 3)
// ============================================

/**
 * Celebration tier based on achievement significance
 */
export type CelebrationTier = 'micro' | 'badge' | 'full'

/**
 * Celebration event
 * Represents a celebration to show to user
 */
export interface Celebration {
  id: string
  userId: string
  tier: CelebrationTier
  title: string
  message: string
  triggerType: CompletionType | 'weekly-review' | 'milestone'
  triggerId?: string // ID of the triggering event
  shownAt?: Date
  dismissed: boolean
  createdAt: Date
}

/**
 * Badge Progress
 * Tracks progress toward earning a badge
 */
export interface BadgeProgress {
  badgeType: BadgeType
  displayName: string
  description: string
  current: number
  target: number
  percentComplete: number
  rarity: BadgeRarity
}

// ============================================
// Priority & Recommendations
// ============================================

/**
 * Priority score for task recommendation
 */
export interface TaskPriority {
  taskId: string
  score: number
  reasons: string[]
}

/**
 * What's Next recommendation
 */
export interface WhatsNextRecommendation {
  task: Task
  priority: TaskPriority
  lastParkingContext?: ContextParking
  streakInfo?: {
    currentDays: number
    message: string
  }
}

// ============================================
// Storage Keys
// ============================================

export const ASSISTANT_STORAGE_KEYS = {
  TASKS: 'assistant_tasks',
  CONTEXT_PARKING: 'assistant_context_parking',
  COMPLETIONS: 'assistant_completions',
  STREAKS: 'assistant_streaks',
  BADGES: 'assistant_badges',
  SETTINGS: 'assistant_settings',
  // Phase 2 keys
  COMMUNICATIONS: 'assistant_communications',
  DECISIONS: 'assistant_decisions',
  BLOCKERS: 'assistant_blockers',
  HANDOFFS: 'assistant_handoffs',
  DEADLINE_RISKS: 'assistant_deadline_risks',
  // Phase 3 keys
  ENERGY_SNAPSHOTS: 'assistant_energy_snapshots',
  DISTRACTIONS: 'assistant_distractions',
  WEEKLY_REVIEWS: 'assistant_weekly_reviews',
  CELEBRATIONS: 'assistant_celebrations',
} as const

export const ASSISTANT_BROADCAST_CHANNEL = 'assistant_sync_channel'

// ============================================
// Badge Definitions (Static Data)
// ============================================

export const BADGE_DEFINITIONS: BadgeDefinition[] = [
  {
    type: 'first-task',
    displayName: 'First Steps',
    description: 'Complete your first task',
    icon: 'Rocket',
    rarity: 'common',
    requirement: { type: 'task-count', value: 1 },
  },
  {
    type: 'task-master-10',
    displayName: 'Getting Started',
    description: 'Complete 10 tasks',
    icon: 'CheckCircle',
    rarity: 'common',
    requirement: { type: 'task-count', value: 10 },
  },
  {
    type: 'task-master-50',
    displayName: 'Productive',
    description: 'Complete 50 tasks',
    icon: 'CheckCircle2',
    rarity: 'uncommon',
    requirement: { type: 'task-count', value: 50 },
  },
  {
    type: 'task-master-100',
    displayName: 'Task Master',
    description: 'Complete 100 tasks',
    icon: 'Trophy',
    rarity: 'rare',
    requirement: { type: 'task-count', value: 100 },
  },
  {
    type: 'streak-3',
    displayName: 'Warming Up',
    description: 'Maintain a 3-day completion streak',
    icon: 'Flame',
    rarity: 'common',
    requirement: { type: 'streak-days', value: 3 },
  },
  {
    type: 'streak-7',
    displayName: 'On Fire',
    description: 'Maintain a 7-day completion streak',
    icon: 'Flame',
    rarity: 'uncommon',
    requirement: { type: 'streak-days', value: 7 },
  },
  {
    type: 'streak-14',
    displayName: 'Unstoppable',
    description: 'Maintain a 14-day completion streak',
    icon: 'Flame',
    rarity: 'rare',
    requirement: { type: 'streak-days', value: 14 },
  },
  {
    type: 'streak-30',
    displayName: 'Legendary Focus',
    description: 'Maintain a 30-day completion streak',
    icon: 'Crown',
    rarity: 'legendary',
    requirement: { type: 'streak-days', value: 30 },
  },
  {
    type: 'first-critical',
    displayName: 'Crisis Averted',
    description: 'Complete your first critical task',
    icon: 'AlertTriangle',
    rarity: 'common',
    requirement: { type: 'first-action', value: 1, action: 'critical-complete' },
  },
  {
    type: 'context-keeper',
    displayName: 'Context Keeper',
    description: 'Park context 10 times',
    icon: 'ParkingCircle',
    rarity: 'uncommon',
    requirement: { type: 'task-count', value: 10 },
  },
  {
    type: 'focus-warrior',
    displayName: 'Focus Warrior',
    description: 'Log 10 hours of focus time',
    icon: 'Target',
    rarity: 'rare',
    requirement: { type: 'focus-time', value: 600 }, // 600 minutes
  },
  {
    type: 'decision-maker',
    displayName: 'Decision Maker',
    description: 'Log 25 decisions',
    icon: 'Scale',
    rarity: 'uncommon',
    requirement: { type: 'decision-count', value: 25 },
  },
  {
    type: 'communicator',
    displayName: 'Clear Communicator',
    description: 'Log 50 communication entries',
    icon: 'MessageSquare',
    rarity: 'rare',
    requirement: { type: 'communication-count', value: 50 },
  },
  {
    type: 'deep-worker',
    displayName: 'Deep Worker',
    description: 'Log 20 hours of deep work',
    icon: 'Brain',
    rarity: 'legendary',
    requirement: { type: 'focus-time', value: 1200 }, // 1200 minutes
  },
]

// ============================================
// Utility Functions
// ============================================

/**
 * Generate a unique task ID
 */
export function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique context parking ID
 */
export function generateParkingId(): string {
  return `park_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique completion event ID
 */
export function generateCompletionId(): string {
  return `comp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique badge ID
 */
export function generateBadgeId(): string {
  return `badge_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique communication entry ID
 */
export function generateCommunicationId(): string {
  return `comm_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique decision ID
 */
export function generateDecisionId(): string {
  return `dec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique blocker ID
 */
export function generateBlockerId(): string {
  return `block_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique energy snapshot ID
 */
export function generateEnergySnapshotId(): string {
  return `energy_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique handoff document ID
 */
export function generateHandoffId(): string {
  return `handoff_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique deadline risk ID
 */
export function generateDeadlineRiskId(): string {
  return `risk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique distraction ID
 */
export function generateDistractionId(): string {
  return `dist_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique weekly review ID
 */
export function generateWeeklyReviewId(): string {
  return `review_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Generate a unique celebration ID
 */
export function generateCelebrationId(): string {
  return `celeb_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Get urgency color class
 */
export function getUrgencyColor(urgency: UrgencyLevel): {
  bg: string
  border: string
  text: string
  dot: string
} {
  switch (urgency) {
    case 'critical':
      return {
        bg: 'bg-red-500/10',
        border: 'border-red-500/30',
        text: 'text-red-400',
        dot: 'bg-red-500',
      }
    case 'important':
      return {
        bg: 'bg-orange-500/10',
        border: 'border-orange-500/30',
        text: 'text-orange-400',
        dot: 'bg-orange-500',
      }
    case 'nice-to-have':
      return {
        bg: 'bg-yellow-500/10',
        border: 'border-yellow-500/30',
        text: 'text-yellow-400',
        dot: 'bg-yellow-500',
      }
  }
}

/**
 * Get status display info
 */
export function getStatusInfo(status: TaskStatus): {
  label: string
  color: string
  icon: string
} {
  switch (status) {
    case 'backlog':
      return { label: 'Backlog', color: 'text-gray-400', icon: 'Circle' }
    case 'in-progress':
      return { label: 'In Progress', color: 'text-blue-400', icon: 'Play' }
    case 'blocked':
      return { label: 'Blocked', color: 'text-red-400', icon: 'Ban' }
    case 'completed':
      return { label: 'Completed', color: 'text-green-400', icon: 'CheckCircle' }
  }
}

/**
 * Get badge rarity color
 */
export function getBadgeRarityColor(rarity: BadgeRarity): string {
  switch (rarity) {
    case 'common':
      return 'text-gray-400 border-gray-400/30'
    case 'uncommon':
      return 'text-green-400 border-green-400/30'
    case 'rare':
      return 'text-purple-400 border-purple-400/30'
    case 'legendary':
      return 'text-amber-400 border-amber-400/30'
  }
}

/**
 * Get deadline risk color
 */
export function getDeadlineRiskColor(riskLevel: DeadlineRiskLevel): {
  bg: string
  border: string
  text: string
} {
  switch (riskLevel) {
    case 'green':
      return {
        bg: 'bg-green-500/10',
        border: 'border-green-500/30',
        text: 'text-green-400',
      }
    case 'yellow':
      return {
        bg: 'bg-yellow-500/10',
        border: 'border-yellow-500/30',
        text: 'text-yellow-400',
      }
    case 'red':
      return {
        bg: 'bg-red-500/10',
        border: 'border-red-500/30',
        text: 'text-red-400',
      }
  }
}

/**
 * Get celebration tier display info
 */
export function getCelebrationTierInfo(tier: CelebrationTier): {
  label: string
  color: string
  duration: number // milliseconds
} {
  switch (tier) {
    case 'micro':
      return { label: 'Nice!', color: 'text-green-400', duration: 1500 }
    case 'badge':
      return { label: 'Badge Earned!', color: 'text-purple-400', duration: 3000 }
    case 'full':
      return { label: 'Achievement Unlocked!', color: 'text-amber-400', duration: 5000 }
  }
}

/**
 * Get work type display info
 */
export function getWorkTypeInfo(workType: WorkType): {
  label: string
  color: string
  icon: string
} {
  switch (workType) {
    case 'deep-work':
      return { label: 'Deep Work', color: 'text-purple-400', icon: 'Brain' }
    case 'communication':
      return { label: 'Communication', color: 'text-blue-400', icon: 'MessageSquare' }
    case 'admin':
      return { label: 'Admin', color: 'text-gray-400', icon: 'FileText' }
    case 'meeting':
      return { label: 'Meeting', color: 'text-orange-400', icon: 'Users' }
  }
}
