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
} from '../../types'
import {
  ASSISTANT_STORAGE_KEYS,
  ASSISTANT_BROADCAST_CHANNEL,
  generateTaskId,
  generateParkingId,
  generateCompletionId,
  generateBadgeId,
  BADGE_DEFINITIONS,
} from '../../types'
import type {
  AssistantStorageAdapter,
  AssistantSyncMessage,
  CompletionQueryOptions,
  CompletionStats,
} from './types'
import { ASSISTANT_SYNC_CONFIG } from './config'

/**
 * localStorage-based storage adapter for Assistant module
 * Includes cross-tab synchronization via BroadcastChannel
 */
export class AssistantLocalStorageAdapter implements AssistantStorageAdapter {
  private initialized = false
  private broadcastChannel: BroadcastChannel | null = null
  private tabId: string
  private taskWatchers: Map<string, (tasks: Task[]) => void> = new Map()
  private streakWatchers: Map<string, (streak: Streak | null) => void> = new Map()
  private badgeWatchers: Map<string, (badges: Badge[]) => void> = new Map()

  constructor() {
    this.tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    // Setup BroadcastChannel for cross-tab sync
    if (typeof BroadcastChannel !== 'undefined') {
      this.broadcastChannel = new BroadcastChannel(ASSISTANT_BROADCAST_CHANNEL)
      this.broadcastChannel.onmessage = (event) => {
        this.handleSyncMessage(event.data as AssistantSyncMessage)
      }
    }

    // Listen for storage events (fallback for older browsers)
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorageEvent.bind(this))
    }

    this.initialized = true
  }

  isInitialized(): boolean {
    return this.initialized
  }

  // ============================================
  // Task Operations
  // ============================================

  async getTasks(userId: string): Promise<Task[]> {
    const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {}
    return Object.values(data)
      .filter((t) => t.userId === userId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }

  async getTask(id: string): Promise<Task | null> {
    const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {}
    return data[id] || null
  }

  async createTask(input: TaskInput, userId: string): Promise<Task> {
    const now = new Date()
    const task: Task = {
      id: generateTaskId(),
      userId,
      title: input.title,
      description: input.description ?? '',
      projectId: input.projectId,
      deadline: input.deadline,
      urgencyLevel: input.urgencyLevel ?? 'nice-to-have',
      isShippingBlocker: input.isShippingBlocker ?? false,
      linkedGitHub: input.linkedGitHub,
      status: input.status ?? 'backlog',
      focusTimeLogged: 0,
      createdAt: now,
      updatedAt: now,
    }

    const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {}
    data[task.id] = task
    this.writeStorage(ASSISTANT_STORAGE_KEYS.TASKS, data)

    this.broadcast({
      type: 'TASK_CREATED',
      payload: task,
      timestamp: Date.now(),
      sourceTab: this.tabId,
    })

    const userTasks = Object.values(data).filter((t) => t.userId === userId)
    this.notifyTaskWatchersDirect(userTasks)

    return task
  }

  async updateTask(id: string, updates: TaskUpdate): Promise<Task> {
    const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {}
    const existing = data[id]

    if (!existing) {
      throw new Error(`Task ${id} not found`)
    }

    const updated: Task = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    }

    data[id] = updated
    this.writeStorage(ASSISTANT_STORAGE_KEYS.TASKS, data)

    this.broadcast({
      type: 'TASK_UPDATED',
      payload: updated,
      timestamp: Date.now(),
      sourceTab: this.tabId,
    })

    const userTasks = Object.values(data).filter((t) => t.userId === existing.userId)
    this.notifyTaskWatchersDirect(userTasks)

    return updated
  }

  async deleteTask(id: string): Promise<void> {
    const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {}
    const task = data[id]

    if (task) {
      const userId = task.userId
      delete data[id]
      this.writeStorage(ASSISTANT_STORAGE_KEYS.TASKS, data)

      this.broadcast({
        type: 'TASK_DELETED',
        payload: { id },
        timestamp: Date.now(),
        sourceTab: this.tabId,
      })

      const userTasks = Object.values(data).filter((t) => t.userId === userId)
      this.notifyTaskWatchersDirect(userTasks)
    }
  }

  // ============================================
  // Context Parking Operations
  // ============================================

  async getParkingHistory(userId: string, taskId?: string): Promise<ContextParking[]> {
    const data =
      this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {}
    let entries = Object.values(data).filter((p) => p.userId === userId)

    if (taskId) {
      entries = entries.filter((p) => p.taskId === taskId)
    }

    return entries.sort((a, b) => new Date(b.parkedAt).getTime() - new Date(a.parkedAt).getTime())
  }

  async getActiveParking(taskId: string): Promise<ContextParking | null> {
    const data =
      this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {}
    const entries = Object.values(data).filter(
      (p) => p.taskId === taskId && p.status === 'active'
    )

    // Return most recent active parking
    return (
      entries.sort(
        (a, b) => new Date(b.parkedAt).getTime() - new Date(a.parkedAt).getTime()
      )[0] || null
    )
  }

  async parkContext(input: ContextParkingInput, userId: string): Promise<ContextParking> {
    // Archive any existing active parking for this task
    const existingActive = await this.getActiveParking(input.taskId)
    if (existingActive) {
      await this.archiveParking(existingActive.id)
    }

    const now = new Date()
    const parking: ContextParking = {
      id: generateParkingId(),
      userId,
      taskId: input.taskId,
      content: input.content,
      codeContext: input.codeContext,
      discoveryNotes: input.discoveryNotes,
      nextSteps: input.nextSteps,
      parkedAt: now,
      createdAt: now,
      status: 'active',
    }

    const data =
      this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {}
    data[parking.id] = parking
    this.writeStorage(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING, data)

    // Update task with parking context
    await this.updateTask(input.taskId, { contextParkingLot: input.content })

    this.broadcast({
      type: 'CONTEXT_PARKED',
      payload: parking,
      timestamp: Date.now(),
      sourceTab: this.tabId,
    })

    return parking
  }

  async resumeParking(parkingId: string): Promise<ContextParking> {
    const data =
      this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {}
    const parking = data[parkingId]

    if (!parking) {
      throw new Error(`Parking ${parkingId} not found`)
    }

    const updated: ContextParking = {
      ...parking,
      resumedAt: new Date(),
      status: 'resumed',
    }

    data[parkingId] = updated
    this.writeStorage(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING, data)

    this.broadcast({
      type: 'CONTEXT_RESUMED',
      payload: updated,
      timestamp: Date.now(),
      sourceTab: this.tabId,
    })

    return updated
  }

  async archiveParking(parkingId: string): Promise<void> {
    const data =
      this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {}
    const parking = data[parkingId]

    if (parking) {
      data[parkingId] = {
        ...parking,
        status: 'archived',
      }
      this.writeStorage(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING, data)
    }
  }

  // ============================================
  // Completion & Celebration Operations
  // ============================================

  async logCompletion(input: CompletionEventInput, userId: string): Promise<CompletionEvent> {
    const now = new Date()
    const completion: CompletionEvent = {
      id: generateCompletionId(),
      userId,
      taskId: input.taskId,
      completionType: input.completionType,
      completedAt: now,
      celebrationShown: false,
      metadata: input.metadata ?? {},
    }

    const data =
      this.readStorage<Record<string, CompletionEvent>>(ASSISTANT_STORAGE_KEYS.COMPLETIONS) || {}
    data[completion.id] = completion

    // Prune old entries
    const pruned = this.pruneCompletions(Object.values(data))
    const prunedData = Object.fromEntries(pruned.map((c) => [c.id, c]))
    this.writeStorage(ASSISTANT_STORAGE_KEYS.COMPLETIONS, prunedData)

    this.broadcast({
      type: 'COMPLETION_LOGGED',
      payload: completion,
      timestamp: Date.now(),
      sourceTab: this.tabId,
    })

    return completion
  }

  async getCompletions(
    userId: string,
    options?: CompletionQueryOptions
  ): Promise<CompletionEvent[]> {
    const data =
      this.readStorage<Record<string, CompletionEvent>>(ASSISTANT_STORAGE_KEYS.COMPLETIONS) || {}

    let filtered = Object.values(data).filter((c) => c.userId === userId)

    if (options?.startDate) {
      filtered = filtered.filter((c) => new Date(c.completedAt) >= options.startDate!)
    }

    if (options?.endDate) {
      filtered = filtered.filter((c) => new Date(c.completedAt) <= options.endDate!)
    }

    // Sort by date descending
    filtered.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())

    if (options?.offset) {
      filtered = filtered.slice(options.offset)
    }

    if (options?.limit) {
      filtered = filtered.slice(0, options.limit)
    }

    return filtered
  }

  async getCompletionStats(userId: string): Promise<CompletionStats> {
    const completions = await this.getCompletions(userId)
    const streak = await this.getStreak(userId)

    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfWeek = new Date(startOfDay)
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay())

    const taskCompletions = completions.filter((c) => c.completionType === 'task-complete')

    return {
      totalTasksCompleted: taskCompletions.length,
      totalFocusTime: taskCompletions.reduce(
        (sum, c) => sum + (c.metadata.focusTimeSpent ?? 0),
        0
      ),
      tasksCompletedToday: taskCompletions.filter(
        (c) => new Date(c.completedAt) >= startOfDay
      ).length,
      tasksCompletedThisWeek: taskCompletions.filter(
        (c) => new Date(c.completedAt) >= startOfWeek
      ).length,
      criticalTasksCompleted: taskCompletions.filter(
        (c) => c.metadata.taskUrgency === 'critical'
      ).length,
      currentStreak: streak?.currentStreakDays ?? 0,
      longestStreak: streak?.longestStreakDays ?? 0,
    }
  }

  // ============================================
  // Streak Operations
  // ============================================

  async getStreak(userId: string): Promise<Streak | null> {
    const data = this.readStorage<Record<string, Streak>>(ASSISTANT_STORAGE_KEYS.STREAKS) || {}
    return data[userId] || null
  }

  async updateStreak(userId: string): Promise<Streak> {
    const data = this.readStorage<Record<string, Streak>>(ASSISTANT_STORAGE_KEYS.STREAKS) || {}
    const existing = data[userId]
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    if (!existing) {
      // First ever completion
      const streak: Streak = {
        userId,
        currentStreakDays: 1,
        longestStreakDays: 1,
        lastTaskCompletionDate: now,
        streakResetDate: today,
      }
      data[userId] = streak
      this.writeStorage(ASSISTANT_STORAGE_KEYS.STREAKS, data)
      this.notifyStreakWatchers(userId, streak)
      return streak
    }

    const lastCompletion = new Date(existing.lastTaskCompletionDate)
    const lastCompletionDay = new Date(
      lastCompletion.getFullYear(),
      lastCompletion.getMonth(),
      lastCompletion.getDate()
    )

    const daysDiff = Math.floor(
      (today.getTime() - lastCompletionDay.getTime()) / (1000 * 60 * 60 * 24)
    )

    let streak: Streak

    if (daysDiff === 0) {
      // Same day - just update timestamp
      streak = {
        ...existing,
        lastTaskCompletionDate: now,
      }
    } else if (daysDiff === 1) {
      // Consecutive day - increment streak
      const newStreak = existing.currentStreakDays + 1
      streak = {
        ...existing,
        currentStreakDays: newStreak,
        longestStreakDays: Math.max(existing.longestStreakDays, newStreak),
        lastTaskCompletionDate: now,
      }
    } else {
      // Streak broken - reset
      streak = {
        ...existing,
        currentStreakDays: 1,
        lastTaskCompletionDate: now,
        streakResetDate: today,
      }
    }

    data[userId] = streak
    this.writeStorage(ASSISTANT_STORAGE_KEYS.STREAKS, data)

    this.broadcast({
      type: 'STREAK_UPDATED',
      payload: streak,
      timestamp: Date.now(),
      sourceTab: this.tabId,
    })

    this.notifyStreakWatchers(userId, streak)
    return streak
  }

  async resetStreak(userId: string): Promise<Streak> {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    const data = this.readStorage<Record<string, Streak>>(ASSISTANT_STORAGE_KEYS.STREAKS) || {}
    const existing = data[userId]

    const streak: Streak = {
      userId,
      currentStreakDays: 0,
      longestStreakDays: existing?.longestStreakDays ?? 0,
      lastTaskCompletionDate: now,
      streakResetDate: today,
    }

    data[userId] = streak
    this.writeStorage(ASSISTANT_STORAGE_KEYS.STREAKS, data)
    this.notifyStreakWatchers(userId, streak)

    return streak
  }

  // ============================================
  // Badge Operations
  // ============================================

  async getBadges(userId: string): Promise<Badge[]> {
    const data = this.readStorage<Record<string, Badge>>(ASSISTANT_STORAGE_KEYS.BADGES) || {}
    return Object.values(data)
      .filter((b) => b.userId === userId)
      .sort((a, b) => new Date(b.earnedAt).getTime() - new Date(a.earnedAt).getTime())
  }

  async awardBadge(userId: string, badgeType: string): Promise<Badge> {
    const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeType)
    if (!definition) {
      throw new Error(`Badge type ${badgeType} not found`)
    }

    const badge: Badge = {
      id: generateBadgeId(),
      userId,
      badgeType: definition.type,
      earnedAt: new Date(),
      displayName: definition.displayName,
      rarity: definition.rarity,
    }

    const data = this.readStorage<Record<string, Badge>>(ASSISTANT_STORAGE_KEYS.BADGES) || {}
    data[badge.id] = badge
    this.writeStorage(ASSISTANT_STORAGE_KEYS.BADGES, data)

    this.broadcast({
      type: 'BADGE_EARNED',
      payload: badge,
      timestamp: Date.now(),
      sourceTab: this.tabId,
    })

    const userBadges = Object.values(data).filter((b) => b.userId === userId)
    this.notifyBadgeWatchers(userId, userBadges)

    return badge
  }

  async checkBadgeEligibility(userId: string): Promise<string[]> {
    const earnedBadges = await this.getBadges(userId)
    const earnedTypes = new Set(earnedBadges.map((b) => b.badgeType))

    const stats = await this.getCompletionStats(userId)
    const eligibleBadges: string[] = []

    for (const definition of BADGE_DEFINITIONS) {
      if (earnedTypes.has(definition.type)) continue

      let eligible = false

      switch (definition.requirement.type) {
        case 'task-count':
          eligible = stats.totalTasksCompleted >= definition.requirement.value
          break
        case 'streak-days':
          eligible = stats.currentStreak >= definition.requirement.value
          break
        case 'first-action':
          // Special handling for first-action badges
          if (definition.requirement.action === 'critical-complete') {
            eligible = stats.criticalTasksCompleted >= definition.requirement.value
          }
          break
      }

      if (eligible) {
        eligibleBadges.push(definition.type)
      }
    }

    return eligibleBadges
  }

  // ============================================
  // Watchers
  // ============================================

  watchTasks(userId: string, callback: (tasks: Task[]) => void): () => void {
    const watcherId = `${userId}_${Date.now()}`
    this.taskWatchers.set(watcherId, callback)

    // Initial call
    this.getTasks(userId).then(callback)

    return () => {
      this.taskWatchers.delete(watcherId)
    }
  }

  watchStreak(userId: string, callback: (streak: Streak | null) => void): () => void {
    const watcherId = `${userId}_${Date.now()}`
    this.streakWatchers.set(watcherId, callback)

    // Initial call
    this.getStreak(userId).then(callback)

    return () => {
      this.streakWatchers.delete(watcherId)
    }
  }

  watchBadges(userId: string, callback: (badges: Badge[]) => void): () => void {
    const watcherId = `${userId}_${Date.now()}`
    this.badgeWatchers.set(watcherId, callback)

    // Initial call
    this.getBadges(userId).then(callback)

    return () => {
      this.badgeWatchers.delete(watcherId)
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  private readStorage<T>(key: string): T | null {
    if (typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      return JSON.parse(raw, this.dateReviver) as T
    } catch {
      return null
    }
  }

  private writeStorage(key: string, data: unknown): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, JSON.stringify(data))
  }

  private dateReviver(_key: string, value: unknown): unknown {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return new Date(value)
    }
    return value
  }

  private broadcast(message: AssistantSyncMessage): void {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage(message)
    }
  }

  private handleSyncMessage(message: AssistantSyncMessage): void {
    if (message.sourceTab === this.tabId) return

    switch (message.type) {
      case 'TASK_CREATED':
      case 'TASK_UPDATED':
      case 'TASK_DELETED': {
        const task = message.payload as Task
        if (task?.userId) {
          this.notifyTaskWatchers(task.userId)
        }
        break
      }
      case 'STREAK_UPDATED': {
        const streak = message.payload as Streak
        if (streak?.userId) {
          this.notifyStreakWatchers(streak.userId, streak)
        }
        break
      }
      case 'BADGE_EARNED': {
        const badge = message.payload as Badge
        if (badge?.userId) {
          this.getBadges(badge.userId).then((badges) => {
            this.notifyBadgeWatchers(badge.userId, badges)
          })
        }
        break
      }
    }
  }

  private handleStorageEvent(event: StorageEvent): void {
    if (
      event.key === ASSISTANT_STORAGE_KEYS.TASKS ||
      event.key === ASSISTANT_STORAGE_KEYS.STREAKS ||
      event.key === ASSISTANT_STORAGE_KEYS.BADGES
    ) {
      // Re-notify all watchers
      for (const callback of this.taskWatchers.values()) {
        const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {}
        callback(Object.values(data))
      }
    }
  }

  private notifyTaskWatchers(userId: string): void {
    this.getTasks(userId).then((tasks) => {
      for (const callback of this.taskWatchers.values()) {
        callback(tasks)
      }
    })
  }

  private notifyTaskWatchersDirect(tasks: Task[]): void {
    for (const callback of this.taskWatchers.values()) {
      callback(tasks)
    }
  }

  private notifyStreakWatchers(userId: string, streak: Streak | null): void {
    for (const callback of this.streakWatchers.values()) {
      callback(streak)
    }
  }

  private notifyBadgeWatchers(userId: string, badges: Badge[]): void {
    for (const callback of this.badgeWatchers.values()) {
      callback(badges)
    }
  }

  private pruneCompletions(entries: CompletionEvent[]): CompletionEvent[] {
    // Limit by count
    let pruned = entries
      .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
      .slice(0, ASSISTANT_SYNC_CONFIG.MAX_COMPLETION_ENTRIES)

    // Limit by age
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - ASSISTANT_SYNC_CONFIG.COMPLETION_RETENTION_DAYS)

    pruned = pruned.filter((e) => new Date(e.completedAt) >= cutoff)

    return pruned
  }
}
