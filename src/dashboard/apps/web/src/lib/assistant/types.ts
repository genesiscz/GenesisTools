/**
 * Assistant module types
 *
 * Core data models for the Personal AI Assistant:
 * - Task management with deadline hierarchy
 * - Context parking for preserving working memory
 * - Completion celebrations and streaks for ADHD motivation
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
    type: 'task-count' | 'streak-days' | 'first-action'
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
    requirement: { type: 'task-count', value: 600 }, // 600 minutes
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
