import type {
    Badge,
    BadgeProgress,
    Celebration,
    CelebrationTier,
    // Phase 2 types
    CommunicationEntry,
    CommunicationEntryInput,
    CommunicationEntryUpdate,
    CompletionEvent,
    CompletionEventInput,
    ContextParking,
    ContextParkingInput,
    DeadlineRisk,
    DeadlineRiskInput,
    DeadlineRiskLevel,
    DeadlineRiskOption,
    Decision,
    DecisionInput,
    DecisionUpdate,
    Distraction,
    DistractionInput,
    // Phase 3 types
    EnergySnapshot,
    EnergySnapshotInput,
    HandoffDocument,
    HandoffDocumentInput,
    HandoffDocumentUpdate,
    Streak,
    Task,
    TaskBlocker,
    TaskBlockerInput,
    TaskBlockerUpdate,
    TaskInput,
    TaskUpdate,
    WeeklyReview,
    WeeklyReviewInput,
} from "@/lib/assistant/types";
import {
    ASSISTANT_BROADCAST_CHANNEL,
    ASSISTANT_STORAGE_KEYS,
    BADGE_DEFINITIONS,
    generateBadgeId,
    generateBlockerId,
    generateCelebrationId,
    generateCommunicationId,
    generateCompletionId,
    generateDeadlineRiskId,
    generateDecisionId,
    generateDistractionId,
    generateEnergySnapshotId,
    generateHandoffId,
    generateParkingId,
    generateTaskId,
    generateWeeklyReviewId,
} from "@/lib/assistant/types";
import { ASSISTANT_SYNC_CONFIG } from "./config";
import type {
    AssistantStorageAdapter,
    AssistantSyncMessage,
    CommunicationQueryOptions,
    CompletionQueryOptions,
    CompletionStats,
    DecisionQueryOptions,
    DistractionQueryOptions,
    DistractionStats,
    EnergyHeatmapData,
    EnergyQueryOptions,
} from "./types";

/**
 * localStorage-based storage adapter for Assistant module
 * Includes cross-tab synchronization via BroadcastChannel
 */
export class AssistantLocalStorageAdapter implements AssistantStorageAdapter {
    private initialized = false;
    private broadcastChannel: BroadcastChannel | null = null;
    private tabId: string;
    private taskWatchers: Map<string, (tasks: Task[]) => void> = new Map();
    private streakWatchers: Map<string, (streak: Streak | null) => void> = new Map();
    private badgeWatchers: Map<string, (badges: Badge[]) => void> = new Map();
    private communicationWatchers: Map<string, (entries: CommunicationEntry[]) => void> = new Map();
    private decisionWatchers: Map<string, (decisions: Decision[]) => void> = new Map();
    private blockerWatchers: Map<string, (blockers: TaskBlocker[]) => void> = new Map();
    private celebrationWatchers: Map<string, (celebrations: Celebration[]) => void> = new Map();

    constructor() {
        this.tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        // Setup BroadcastChannel for cross-tab sync
        if (typeof BroadcastChannel !== "undefined") {
            this.broadcastChannel = new BroadcastChannel(ASSISTANT_BROADCAST_CHANNEL);
            this.broadcastChannel.onmessage = (event) => {
                this.handleSyncMessage(event.data as AssistantSyncMessage);
            };
        }

        // Listen for storage events (fallback for older browsers)
        if (typeof window !== "undefined") {
            window.addEventListener("storage", this.handleStorageEvent.bind(this));
        }

        this.initialized = true;
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    // ============================================
    // Task Operations
    // ============================================

    async getTasks(userId: string): Promise<Task[]> {
        const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {};
        return Object.values(data)
            .filter((t) => t.userId === userId)
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    async getTask(id: string): Promise<Task | null> {
        const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {};
        return data[id] || null;
    }

    async createTask(input: TaskInput, userId: string): Promise<Task> {
        const now = new Date();
        const task: Task = {
            id: generateTaskId(),
            userId,
            title: input.title,
            description: input.description ?? "",
            projectId: input.projectId,
            deadline: input.deadline,
            urgencyLevel: input.urgencyLevel ?? "nice-to-have",
            isShippingBlocker: input.isShippingBlocker ?? false,
            linkedGitHub: input.linkedGitHub,
            status: input.status ?? "backlog",
            focusTimeLogged: 0,
            createdAt: now,
            updatedAt: now,
        };

        const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {};
        data[task.id] = task;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.TASKS, data);

        this.broadcast({
            type: "TASK_CREATED",
            payload: task,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userTasks = Object.values(data).filter((t) => t.userId === userId);
        this.notifyTaskWatchersDirect(userTasks);

        return task;
    }

    async updateTask(id: string, updates: TaskUpdate): Promise<Task> {
        const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {};
        const existing = data[id];

        if (!existing) {
            throw new Error(`Task ${id} not found`);
        }

        const updated: Task = {
            ...existing,
            ...updates,
            updatedAt: new Date(),
        };

        data[id] = updated;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.TASKS, data);

        this.broadcast({
            type: "TASK_UPDATED",
            payload: updated,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userTasks = Object.values(data).filter((t) => t.userId === existing.userId);
        this.notifyTaskWatchersDirect(userTasks);

        return updated;
    }

    async deleteTask(id: string): Promise<void> {
        const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {};
        const task = data[id];

        if (task) {
            const userId = task.userId;
            delete data[id];
            this.writeStorage(ASSISTANT_STORAGE_KEYS.TASKS, data);

            this.broadcast({
                type: "TASK_DELETED",
                payload: { id },
                timestamp: Date.now(),
                sourceTab: this.tabId,
            });

            const userTasks = Object.values(data).filter((t) => t.userId === userId);
            this.notifyTaskWatchersDirect(userTasks);
        }
    }

    // ============================================
    // Context Parking Operations
    // ============================================

    async getParkingHistory(userId: string, taskId?: string): Promise<ContextParking[]> {
        const data = this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {};
        let entries = Object.values(data).filter((p) => p.userId === userId);

        if (taskId) {
            entries = entries.filter((p) => p.taskId === taskId);
        }

        return entries.sort((a, b) => new Date(b.parkedAt).getTime() - new Date(a.parkedAt).getTime());
    }

    async getActiveParking(taskId: string): Promise<ContextParking | null> {
        const data = this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {};
        const entries = Object.values(data).filter((p) => p.taskId === taskId && p.status === "active");

        // Return most recent active parking
        return entries.sort((a, b) => new Date(b.parkedAt).getTime() - new Date(a.parkedAt).getTime())[0] || null;
    }

    async parkContext(input: ContextParkingInput, userId: string): Promise<ContextParking> {
        // Archive any existing active parking for this task
        const existingActive = await this.getActiveParking(input.taskId);
        if (existingActive) {
            await this.archiveParking(existingActive.id);
        }

        const now = new Date();
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
            status: "active",
        };

        const data = this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {};
        data[parking.id] = parking;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING, data);

        // Update task with parking context
        await this.updateTask(input.taskId, { contextParkingLot: input.content });

        this.broadcast({
            type: "CONTEXT_PARKED",
            payload: parking,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        return parking;
    }

    async resumeParking(parkingId: string): Promise<ContextParking> {
        const data = this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {};
        const parking = data[parkingId];

        if (!parking) {
            throw new Error(`Parking ${parkingId} not found`);
        }

        const updated: ContextParking = {
            ...parking,
            resumedAt: new Date(),
            status: "resumed",
        };

        data[parkingId] = updated;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING, data);

        this.broadcast({
            type: "CONTEXT_RESUMED",
            payload: updated,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        return updated;
    }

    async archiveParking(parkingId: string): Promise<void> {
        const data = this.readStorage<Record<string, ContextParking>>(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING) || {};
        const parking = data[parkingId];

        if (parking) {
            data[parkingId] = {
                ...parking,
                status: "archived",
            };
            this.writeStorage(ASSISTANT_STORAGE_KEYS.CONTEXT_PARKING, data);
        }
    }

    // ============================================
    // Completion & Celebration Operations
    // ============================================

    async logCompletion(input: CompletionEventInput, userId: string): Promise<CompletionEvent> {
        const now = new Date();
        const completion: CompletionEvent = {
            id: generateCompletionId(),
            userId,
            taskId: input.taskId,
            completionType: input.completionType,
            completedAt: now,
            celebrationShown: false,
            metadata: input.metadata ?? {},
        };

        const data = this.readStorage<Record<string, CompletionEvent>>(ASSISTANT_STORAGE_KEYS.COMPLETIONS) || {};
        data[completion.id] = completion;

        // Prune old entries
        const pruned = this.pruneCompletions(Object.values(data));
        const prunedData = Object.fromEntries(pruned.map((c) => [c.id, c]));
        this.writeStorage(ASSISTANT_STORAGE_KEYS.COMPLETIONS, prunedData);

        this.broadcast({
            type: "COMPLETION_LOGGED",
            payload: completion,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        return completion;
    }

    async getCompletions(userId: string, options?: CompletionQueryOptions): Promise<CompletionEvent[]> {
        const data = this.readStorage<Record<string, CompletionEvent>>(ASSISTANT_STORAGE_KEYS.COMPLETIONS) || {};

        let filtered = Object.values(data).filter((c) => c.userId === userId);

        if (options?.startDate) {
            filtered = filtered.filter((c) => new Date(c.completedAt) >= options.startDate!);
        }

        if (options?.endDate) {
            filtered = filtered.filter((c) => new Date(c.completedAt) <= options.endDate!);
        }

        // Sort by date descending
        filtered.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());

        if (options?.offset) {
            filtered = filtered.slice(options.offset);
        }

        if (options?.limit) {
            filtered = filtered.slice(0, options.limit);
        }

        return filtered;
    }

    async getCompletionStats(userId: string): Promise<CompletionStats> {
        const completions = await this.getCompletions(userId);
        const streak = await this.getStreak(userId);

        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfWeek = new Date(startOfDay);
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

        const taskCompletions = completions.filter((c) => c.completionType === "task-complete");

        return {
            totalTasksCompleted: taskCompletions.length,
            totalFocusTime: taskCompletions.reduce((sum, c) => sum + (c.metadata.focusTimeSpent ?? 0), 0),
            tasksCompletedToday: taskCompletions.filter((c) => new Date(c.completedAt) >= startOfDay).length,
            tasksCompletedThisWeek: taskCompletions.filter((c) => new Date(c.completedAt) >= startOfWeek).length,
            criticalTasksCompleted: taskCompletions.filter((c) => c.metadata.taskUrgency === "critical").length,
            currentStreak: streak?.currentStreakDays ?? 0,
            longestStreak: streak?.longestStreakDays ?? 0,
        };
    }

    // ============================================
    // Streak Operations
    // ============================================

    async getStreak(userId: string): Promise<Streak | null> {
        const data = this.readStorage<Record<string, Streak>>(ASSISTANT_STORAGE_KEYS.STREAKS) || {};
        return data[userId] || null;
    }

    async updateStreak(userId: string): Promise<Streak> {
        const data = this.readStorage<Record<string, Streak>>(ASSISTANT_STORAGE_KEYS.STREAKS) || {};
        const existing = data[userId];
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        if (!existing) {
            // First ever completion
            const streak: Streak = {
                userId,
                currentStreakDays: 1,
                longestStreakDays: 1,
                lastTaskCompletionDate: now,
                streakResetDate: today,
            };
            data[userId] = streak;
            this.writeStorage(ASSISTANT_STORAGE_KEYS.STREAKS, data);
            this.notifyStreakWatchers(userId, streak);
            return streak;
        }

        const lastCompletion = new Date(existing.lastTaskCompletionDate);
        const lastCompletionDay = new Date(
            lastCompletion.getFullYear(),
            lastCompletion.getMonth(),
            lastCompletion.getDate()
        );

        const daysDiff = Math.floor((today.getTime() - lastCompletionDay.getTime()) / (1000 * 60 * 60 * 24));

        let streak: Streak;

        if (daysDiff === 0) {
            // Same day - just update timestamp
            streak = {
                ...existing,
                lastTaskCompletionDate: now,
            };
        } else if (daysDiff === 1) {
            // Consecutive day - increment streak
            const newStreak = existing.currentStreakDays + 1;
            streak = {
                ...existing,
                currentStreakDays: newStreak,
                longestStreakDays: Math.max(existing.longestStreakDays, newStreak),
                lastTaskCompletionDate: now,
            };
        } else {
            // Streak broken - reset
            streak = {
                ...existing,
                currentStreakDays: 1,
                lastTaskCompletionDate: now,
                streakResetDate: today,
            };
        }

        data[userId] = streak;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.STREAKS, data);

        this.broadcast({
            type: "STREAK_UPDATED",
            payload: streak,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        this.notifyStreakWatchers(userId, streak);
        return streak;
    }

    async resetStreak(userId: string): Promise<Streak> {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const data = this.readStorage<Record<string, Streak>>(ASSISTANT_STORAGE_KEYS.STREAKS) || {};
        const existing = data[userId];

        const streak: Streak = {
            userId,
            currentStreakDays: 0,
            longestStreakDays: existing?.longestStreakDays ?? 0,
            lastTaskCompletionDate: now,
            streakResetDate: today,
        };

        data[userId] = streak;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.STREAKS, data);
        this.notifyStreakWatchers(userId, streak);

        return streak;
    }

    // ============================================
    // Badge Operations
    // ============================================

    async getBadges(userId: string): Promise<Badge[]> {
        const data = this.readStorage<Record<string, Badge>>(ASSISTANT_STORAGE_KEYS.BADGES) || {};
        return Object.values(data)
            .filter((b) => b.userId === userId)
            .sort((a, b) => new Date(b.earnedAt).getTime() - new Date(a.earnedAt).getTime());
    }

    async awardBadge(userId: string, badgeType: string): Promise<Badge> {
        const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeType);
        if (!definition) {
            throw new Error(`Badge type ${badgeType} not found`);
        }

        const badge: Badge = {
            id: generateBadgeId(),
            userId,
            badgeType: definition.type,
            earnedAt: new Date(),
            displayName: definition.displayName,
            rarity: definition.rarity,
        };

        const data = this.readStorage<Record<string, Badge>>(ASSISTANT_STORAGE_KEYS.BADGES) || {};
        data[badge.id] = badge;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.BADGES, data);

        this.broadcast({
            type: "BADGE_EARNED",
            payload: badge,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userBadges = Object.values(data).filter((b) => b.userId === userId);
        this.notifyBadgeWatchers(userId, userBadges);

        return badge;
    }

    async checkBadgeEligibility(userId: string): Promise<string[]> {
        const earnedBadges = await this.getBadges(userId);
        const earnedTypes = new Set(earnedBadges.map((b) => b.badgeType));

        const stats = await this.getCompletionStats(userId);
        const communications = await this.getCommunicationEntries(userId);
        const decisions = await this.getDecisions(userId);
        const eligibleBadges: string[] = [];

        for (const definition of BADGE_DEFINITIONS) {
            if (earnedTypes.has(definition.type)) {
                continue;
            }

            let eligible = false;

            switch (definition.requirement.type) {
                case "task-count":
                    eligible = stats.totalTasksCompleted >= definition.requirement.value;
                    break;
                case "streak-days":
                    eligible = stats.currentStreak >= definition.requirement.value;
                    break;
                case "first-action":
                    // Special handling for first-action badges
                    if (definition.requirement.action === "critical-complete") {
                        eligible = stats.criticalTasksCompleted >= definition.requirement.value;
                    }
                    break;
                case "focus-time":
                    eligible = stats.totalFocusTime >= definition.requirement.value;
                    break;
                case "decision-count":
                    eligible = decisions.length >= definition.requirement.value;
                    break;
                case "communication-count":
                    eligible = communications.length >= definition.requirement.value;
                    break;
            }

            if (eligible) {
                eligibleBadges.push(definition.type);
            }
        }

        return eligibleBadges;
    }

    // ============================================
    // Communication Log Operations (Phase 2)
    // ============================================

    async getCommunicationEntries(userId: string, options?: CommunicationQueryOptions): Promise<CommunicationEntry[]> {
        const data = this.readStorage<Record<string, CommunicationEntry>>(ASSISTANT_STORAGE_KEYS.COMMUNICATIONS) || {};

        let filtered = Object.values(data).filter((c) => c.userId === userId);

        if (options?.source) {
            filtered = filtered.filter((c) => c.source === options.source);
        }
        if (options?.sentiment) {
            filtered = filtered.filter((c) => c.sentiment === options.sentiment);
        }
        if (options?.tags && options.tags.length > 0) {
            filtered = filtered.filter((c) => options.tags?.some((tag) => c.tags.includes(tag)));
        }
        if (options?.relatedTaskId) {
            filtered = filtered.filter((c) => c.relatedTaskIds.includes(options.relatedTaskId!));
        }
        if (options?.startDate) {
            filtered = filtered.filter((c) => new Date(c.discussedAt) >= options.startDate!);
        }
        if (options?.endDate) {
            filtered = filtered.filter((c) => new Date(c.discussedAt) <= options.endDate!);
        }

        // Sort by discussedAt descending
        filtered.sort((a, b) => new Date(b.discussedAt).getTime() - new Date(a.discussedAt).getTime());

        if (options?.offset) {
            filtered = filtered.slice(options.offset);
        }
        if (options?.limit) {
            filtered = filtered.slice(0, options.limit);
        }

        return filtered;
    }

    async getCommunicationEntry(id: string): Promise<CommunicationEntry | null> {
        const data = this.readStorage<Record<string, CommunicationEntry>>(ASSISTANT_STORAGE_KEYS.COMMUNICATIONS) || {};
        return data[id] || null;
    }

    async createCommunicationEntry(input: CommunicationEntryInput, userId: string): Promise<CommunicationEntry> {
        const now = new Date();
        const entry: CommunicationEntry = {
            id: generateCommunicationId(),
            userId,
            source: input.source,
            title: input.title,
            content: input.content,
            sourceUrl: input.sourceUrl,
            discussedAt: input.discussedAt ?? now,
            tags: input.tags ?? [],
            relatedTaskIds: input.relatedTaskIds ?? [],
            sentiment: input.sentiment ?? "context",
            createdAt: now,
            updatedAt: now,
        };

        const data = this.readStorage<Record<string, CommunicationEntry>>(ASSISTANT_STORAGE_KEYS.COMMUNICATIONS) || {};
        data[entry.id] = entry;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.COMMUNICATIONS, data);

        this.broadcast({
            type: "COMMUNICATION_CREATED",
            payload: entry,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userEntries = Object.values(data).filter((e) => e.userId === userId);
        this.notifyCommunicationWatchers(userId, userEntries);

        return entry;
    }

    async updateCommunicationEntry(id: string, updates: CommunicationEntryUpdate): Promise<CommunicationEntry> {
        const data = this.readStorage<Record<string, CommunicationEntry>>(ASSISTANT_STORAGE_KEYS.COMMUNICATIONS) || {};
        const existing = data[id];

        if (!existing) {
            throw new Error(`Communication entry ${id} not found`);
        }

        const updated: CommunicationEntry = {
            ...existing,
            ...updates,
            updatedAt: new Date(),
        };

        data[id] = updated;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.COMMUNICATIONS, data);

        this.broadcast({
            type: "COMMUNICATION_UPDATED",
            payload: updated,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userEntries = Object.values(data).filter((e) => e.userId === existing.userId);
        this.notifyCommunicationWatchers(existing.userId, userEntries);

        return updated;
    }

    async deleteCommunicationEntry(id: string): Promise<void> {
        const data = this.readStorage<Record<string, CommunicationEntry>>(ASSISTANT_STORAGE_KEYS.COMMUNICATIONS) || {};
        const entry = data[id];

        if (entry) {
            const userId = entry.userId;
            delete data[id];
            this.writeStorage(ASSISTANT_STORAGE_KEYS.COMMUNICATIONS, data);

            this.broadcast({
                type: "COMMUNICATION_DELETED",
                payload: { id },
                timestamp: Date.now(),
                sourceTab: this.tabId,
            });

            const userEntries = Object.values(data).filter((e) => e.userId === userId);
            this.notifyCommunicationWatchers(userId, userEntries);
        }
    }

    // ============================================
    // Decision Log Operations (Phase 2)
    // ============================================

    async getDecisions(userId: string, options?: DecisionQueryOptions): Promise<Decision[]> {
        const data = this.readStorage<Record<string, Decision>>(ASSISTANT_STORAGE_KEYS.DECISIONS) || {};

        let filtered = Object.values(data).filter((d) => d.userId === userId);

        if (options?.status) {
            filtered = filtered.filter((d) => d.status === options.status);
        }
        if (options?.impactArea) {
            filtered = filtered.filter((d) => d.impactArea === options.impactArea);
        }
        if (options?.tags && options.tags.length > 0) {
            filtered = filtered.filter((d) => options.tags?.some((tag) => d.tags.includes(tag)));
        }
        if (options?.relatedTaskId) {
            filtered = filtered.filter((d) => d.relatedTaskIds.includes(options.relatedTaskId!));
        }
        if (options?.startDate) {
            filtered = filtered.filter((d) => new Date(d.decidedAt) >= options.startDate!);
        }
        if (options?.endDate) {
            filtered = filtered.filter((d) => new Date(d.decidedAt) <= options.endDate!);
        }

        // Sort by decidedAt descending
        filtered.sort((a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime());

        if (options?.offset) {
            filtered = filtered.slice(options.offset);
        }
        if (options?.limit) {
            filtered = filtered.slice(0, options.limit);
        }

        return filtered;
    }

    async getDecision(id: string): Promise<Decision | null> {
        const data = this.readStorage<Record<string, Decision>>(ASSISTANT_STORAGE_KEYS.DECISIONS) || {};
        return data[id] || null;
    }

    async createDecision(input: DecisionInput, userId: string): Promise<Decision> {
        const now = new Date();
        const decision: Decision = {
            id: generateDecisionId(),
            userId,
            title: input.title,
            reasoning: input.reasoning,
            alternativesConsidered: input.alternativesConsidered ?? [],
            decidedAt: input.decidedAt ?? now,
            decidedBy: input.decidedBy ?? "self",
            status: "active",
            impactArea: input.impactArea,
            relatedTaskIds: input.relatedTaskIds ?? [],
            tags: input.tags ?? [],
            createdAt: now,
            updatedAt: now,
        };

        const data = this.readStorage<Record<string, Decision>>(ASSISTANT_STORAGE_KEYS.DECISIONS) || {};
        data[decision.id] = decision;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.DECISIONS, data);

        this.broadcast({
            type: "DECISION_CREATED",
            payload: decision,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userDecisions = Object.values(data).filter((d) => d.userId === userId);
        this.notifyDecisionWatchers(userId, userDecisions);

        return decision;
    }

    async updateDecision(id: string, updates: DecisionUpdate): Promise<Decision> {
        const data = this.readStorage<Record<string, Decision>>(ASSISTANT_STORAGE_KEYS.DECISIONS) || {};
        const existing = data[id];

        if (!existing) {
            throw new Error(`Decision ${id} not found`);
        }

        const updated: Decision = {
            ...existing,
            ...updates,
            updatedAt: new Date(),
        };

        data[id] = updated;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.DECISIONS, data);

        this.broadcast({
            type: "DECISION_UPDATED",
            payload: updated,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userDecisions = Object.values(data).filter((d) => d.userId === existing.userId);
        this.notifyDecisionWatchers(existing.userId, userDecisions);

        return updated;
    }

    async deleteDecision(id: string): Promise<void> {
        const data = this.readStorage<Record<string, Decision>>(ASSISTANT_STORAGE_KEYS.DECISIONS) || {};
        const decision = data[id];

        if (decision) {
            const userId = decision.userId;
            delete data[id];
            this.writeStorage(ASSISTANT_STORAGE_KEYS.DECISIONS, data);

            this.broadcast({
                type: "DECISION_DELETED",
                payload: { id },
                timestamp: Date.now(),
                sourceTab: this.tabId,
            });

            const userDecisions = Object.values(data).filter((d) => d.userId === userId);
            this.notifyDecisionWatchers(userId, userDecisions);
        }
    }

    async supersedeDecision(id: string, newDecisionId: string): Promise<Decision> {
        return this.updateDecision(id, {
            status: "superseded",
            supersededBy: newDecisionId,
        });
    }

    async reverseDecision(id: string, reason: string): Promise<Decision> {
        return this.updateDecision(id, {
            status: "reversed",
            reversalReason: reason,
        });
    }

    // ============================================
    // Task Blocker Operations (Phase 2)
    // ============================================

    async getBlockers(userId: string, taskId?: string): Promise<TaskBlocker[]> {
        const data = this.readStorage<Record<string, TaskBlocker>>(ASSISTANT_STORAGE_KEYS.BLOCKERS) || {};

        let filtered = Object.values(data).filter((b) => b.userId === userId);

        if (taskId) {
            filtered = filtered.filter((b) => b.taskId === taskId);
        }

        // Sort by blockedSince descending
        return filtered.sort((a, b) => new Date(b.blockedSince).getTime() - new Date(a.blockedSince).getTime());
    }

    async getActiveBlocker(taskId: string): Promise<TaskBlocker | null> {
        const data = this.readStorage<Record<string, TaskBlocker>>(ASSISTANT_STORAGE_KEYS.BLOCKERS) || {};

        const active = Object.values(data).filter((b) => b.taskId === taskId && !b.unblockedAt);

        return active[0] || null;
    }

    async createBlocker(input: TaskBlockerInput, userId: string): Promise<TaskBlocker> {
        const now = new Date();
        const blocker: TaskBlocker = {
            id: generateBlockerId(),
            userId,
            taskId: input.taskId,
            reason: input.reason,
            blockedSince: now,
            blockerOwner: input.blockerOwner,
            followUpAction: input.followUpAction,
            reminderSet: input.reminderSet,
            createdAt: now,
            updatedAt: now,
        };

        const data = this.readStorage<Record<string, TaskBlocker>>(ASSISTANT_STORAGE_KEYS.BLOCKERS) || {};
        data[blocker.id] = blocker;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.BLOCKERS, data);

        // Update task status to blocked
        await this.updateTask(input.taskId, { status: "blocked" });

        this.broadcast({
            type: "BLOCKER_CREATED",
            payload: blocker,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userBlockers = Object.values(data).filter((b) => b.userId === userId);
        this.notifyBlockerWatchers(userId, userBlockers);

        return blocker;
    }

    async updateBlocker(id: string, updates: TaskBlockerUpdate): Promise<TaskBlocker> {
        const data = this.readStorage<Record<string, TaskBlocker>>(ASSISTANT_STORAGE_KEYS.BLOCKERS) || {};
        const existing = data[id];

        if (!existing) {
            throw new Error(`Blocker ${id} not found`);
        }

        const updated: TaskBlocker = {
            ...existing,
            ...updates,
            updatedAt: new Date(),
        };

        data[id] = updated;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.BLOCKERS, data);

        this.broadcast({
            type: "BLOCKER_UPDATED",
            payload: updated,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userBlockers = Object.values(data).filter((b) => b.userId === existing.userId);
        this.notifyBlockerWatchers(existing.userId, userBlockers);

        return updated;
    }

    async resolveBlocker(id: string): Promise<TaskBlocker> {
        const data = this.readStorage<Record<string, TaskBlocker>>(ASSISTANT_STORAGE_KEYS.BLOCKERS) || {};
        const existing = data[id];

        if (!existing) {
            throw new Error(`Blocker ${id} not found`);
        }

        const resolved = await this.updateBlocker(id, { unblockedAt: new Date() });

        // Update task status to in-progress if no other active blockers
        const remainingBlockers = await this.getActiveBlocker(existing.taskId);
        if (!remainingBlockers) {
            await this.updateTask(existing.taskId, { status: "in-progress" });
        }

        this.broadcast({
            type: "BLOCKER_RESOLVED",
            payload: resolved,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        return resolved;
    }

    async deleteBlocker(id: string): Promise<void> {
        const data = this.readStorage<Record<string, TaskBlocker>>(ASSISTANT_STORAGE_KEYS.BLOCKERS) || {};
        const blocker = data[id];

        if (blocker) {
            const userId = blocker.userId;
            delete data[id];
            this.writeStorage(ASSISTANT_STORAGE_KEYS.BLOCKERS, data);

            const userBlockers = Object.values(data).filter((b) => b.userId === userId);
            this.notifyBlockerWatchers(userId, userBlockers);
        }
    }

    // ============================================
    // Handoff Document Operations (Phase 2)
    // ============================================

    async getHandoffs(userId: string, taskId?: string): Promise<HandoffDocument[]> {
        const data = this.readStorage<Record<string, HandoffDocument>>(ASSISTANT_STORAGE_KEYS.HANDOFFS) || {};

        let filtered = Object.values(data).filter((h) => h.userId === userId);

        if (taskId) {
            filtered = filtered.filter((h) => h.taskId === taskId);
        }

        return filtered.sort((a, b) => new Date(b.handoffAt).getTime() - new Date(a.handoffAt).getTime());
    }

    async getHandoff(id: string): Promise<HandoffDocument | null> {
        const data = this.readStorage<Record<string, HandoffDocument>>(ASSISTANT_STORAGE_KEYS.HANDOFFS) || {};
        return data[id] || null;
    }

    async createHandoff(input: HandoffDocumentInput, userId: string): Promise<HandoffDocument> {
        const now = new Date();
        const handoff: HandoffDocument = {
            id: generateHandoffId(),
            userId,
            taskId: input.taskId,
            handedOffFrom: userId, // Current user
            handedOffTo: input.handedOffTo,
            handoffAt: now,
            summary: input.summary,
            contextNotes: input.contextNotes,
            decisions: input.decisions ?? [],
            blockers: input.blockers ?? [],
            nextSteps: input.nextSteps,
            gotchas: input.gotchas,
            contact: input.contact,
            reviewed: false,
            createdAt: now,
            updatedAt: now,
        };

        const data = this.readStorage<Record<string, HandoffDocument>>(ASSISTANT_STORAGE_KEYS.HANDOFFS) || {};
        data[handoff.id] = handoff;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.HANDOFFS, data);

        this.broadcast({
            type: "HANDOFF_CREATED",
            payload: handoff,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        return handoff;
    }

    async updateHandoff(id: string, updates: HandoffDocumentUpdate): Promise<HandoffDocument> {
        const data = this.readStorage<Record<string, HandoffDocument>>(ASSISTANT_STORAGE_KEYS.HANDOFFS) || {};
        const existing = data[id];

        if (!existing) {
            throw new Error(`Handoff ${id} not found`);
        }

        const updated: HandoffDocument = {
            ...existing,
            ...updates,
            updatedAt: new Date(),
        };

        data[id] = updated;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.HANDOFFS, data);

        return updated;
    }

    async acknowledgeHandoff(id: string): Promise<HandoffDocument> {
        const updated = await this.updateHandoff(id, {
            reviewed: true,
            reviewedAt: new Date(),
        });

        this.broadcast({
            type: "HANDOFF_ACKNOWLEDGED",
            payload: updated,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        return updated;
    }

    async deleteHandoff(id: string): Promise<void> {
        const data = this.readStorage<Record<string, HandoffDocument>>(ASSISTANT_STORAGE_KEYS.HANDOFFS) || {};

        if (data[id]) {
            delete data[id];
            this.writeStorage(ASSISTANT_STORAGE_KEYS.HANDOFFS, data);
        }
    }

    // ============================================
    // Deadline Risk Operations (Phase 2)
    // ============================================

    async getDeadlineRisks(userId: string): Promise<DeadlineRisk[]> {
        const data = this.readStorage<Record<string, DeadlineRisk>>(ASSISTANT_STORAGE_KEYS.DEADLINE_RISKS) || {};

        return Object.values(data)
            .filter((r) => r.userId === userId)
            .sort((a, b) => new Date(b.calculatedAt).getTime() - new Date(a.calculatedAt).getTime());
    }

    async calculateDeadlineRisk(input: DeadlineRiskInput, userId: string): Promise<DeadlineRisk> {
        const task = await this.getTask(input.taskId);
        if (!task) {
            throw new Error(`Task ${input.taskId} not found`);
        }

        if (!task.deadline) {
            throw new Error(`Task ${input.taskId} has no deadline`);
        }

        const now = new Date();
        const deadline = new Date(task.deadline);
        const percentComplete = input.percentComplete ?? 0;

        // Calculate days remaining
        const daysRemaining = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        // Estimate projected completion based on progress
        let projectedCompletionDate: Date;
        if (percentComplete > 0) {
            const daysElapsed = Math.ceil((now.getTime() - new Date(task.createdAt).getTime()) / (1000 * 60 * 60 * 24));
            const estimatedTotalDays = Math.ceil(daysElapsed / (percentComplete / 100));
            projectedCompletionDate = new Date(task.createdAt);
            projectedCompletionDate.setDate(projectedCompletionDate.getDate() + estimatedTotalDays);
        } else {
            projectedCompletionDate = input.projectedCompletionDate ?? deadline;
        }

        // Calculate days late (negative means early)
        const daysLate = Math.ceil((projectedCompletionDate.getTime() - deadline.getTime()) / (1000 * 60 * 60 * 24));

        // Determine risk level
        let riskLevel: DeadlineRiskLevel;
        if (daysLate > 0 || daysRemaining < 0) {
            riskLevel = "red";
        } else if (daysRemaining <= 2 || (percentComplete < 50 && daysRemaining <= 5)) {
            riskLevel = "yellow";
        } else {
            riskLevel = "green";
        }

        // Recommend action
        let recommendedOption: DeadlineRiskOption;
        if (riskLevel === "red") {
            if (percentComplete < 30) {
                recommendedOption = "scope";
            } else {
                recommendedOption = "extend";
            }
        } else if (riskLevel === "yellow") {
            if (percentComplete < 50) {
                recommendedOption = "help";
            } else {
                recommendedOption = "accept";
            }
        } else {
            recommendedOption = "accept";
        }

        const risk: DeadlineRisk = {
            id: generateDeadlineRiskId(),
            userId,
            taskId: input.taskId,
            riskLevel,
            projectedCompletionDate,
            daysLate,
            daysRemaining,
            percentComplete,
            recommendedOption,
            calculatedAt: now,
            createdAt: now,
        };

        const data = this.readStorage<Record<string, DeadlineRisk>>(ASSISTANT_STORAGE_KEYS.DEADLINE_RISKS) || {};
        data[risk.id] = risk;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.DEADLINE_RISKS, data);

        return risk;
    }

    async getDeadlineRiskForTask(taskId: string): Promise<DeadlineRisk | null> {
        const data = this.readStorage<Record<string, DeadlineRisk>>(ASSISTANT_STORAGE_KEYS.DEADLINE_RISKS) || {};

        const risks = Object.values(data)
            .filter((r) => r.taskId === taskId)
            .sort((a, b) => new Date(b.calculatedAt).getTime() - new Date(a.calculatedAt).getTime());

        return risks[0] || null;
    }

    // ============================================
    // Energy Snapshot Operations (Phase 3)
    // ============================================

    async getEnergySnapshots(userId: string, options?: EnergyQueryOptions): Promise<EnergySnapshot[]> {
        const data = this.readStorage<Record<string, EnergySnapshot>>(ASSISTANT_STORAGE_KEYS.ENERGY_SNAPSHOTS) || {};

        let filtered = Object.values(data).filter((e) => e.userId === userId);

        if (options?.startDate) {
            filtered = filtered.filter((e) => new Date(e.timestamp) >= options.startDate!);
        }
        if (options?.endDate) {
            filtered = filtered.filter((e) => new Date(e.timestamp) <= options.endDate!);
        }
        if (options?.workType) {
            filtered = filtered.filter((e) => e.typeOfWork === options.workType);
        }

        // Sort by timestamp descending
        filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        if (options?.offset) {
            filtered = filtered.slice(options.offset);
        }
        if (options?.limit) {
            filtered = filtered.slice(0, options.limit);
        }

        return filtered;
    }

    async logEnergySnapshot(input: EnergySnapshotInput, userId: string): Promise<EnergySnapshot> {
        const now = new Date();
        const snapshot: EnergySnapshot = {
            id: generateEnergySnapshotId(),
            userId,
            timestamp: input.timestamp ?? now,
            focusQuality: input.focusQuality,
            contextSwitches: input.contextSwitches ?? 0,
            tasksCompleted: input.tasksCompleted ?? 0,
            typeOfWork: input.typeOfWork,
            notes: input.notes,
            createdAt: now,
        };

        const data = this.readStorage<Record<string, EnergySnapshot>>(ASSISTANT_STORAGE_KEYS.ENERGY_SNAPSHOTS) || {};
        data[snapshot.id] = snapshot;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.ENERGY_SNAPSHOTS, data);

        this.broadcast({
            type: "ENERGY_LOGGED",
            payload: snapshot,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        return snapshot;
    }

    async getEnergyHeatmapData(userId: string, startDate: Date, endDate: Date): Promise<EnergyHeatmapData> {
        const snapshots = await this.getEnergySnapshots(userId, { startDate, endDate });

        // Group by date and hour
        const cellMap: Map<string, { total: number; count: number }> = new Map();
        const hourlyTotals: Record<number, { total: number; count: number }> = {};
        const dailyTotals: Record<number, { total: number; count: number }> = {};

        for (const snap of snapshots) {
            const date = new Date(snap.timestamp);
            const dateStr = date.toISOString().split("T")[0];
            const hour = date.getHours();
            const dayOfWeek = date.getDay();

            // Cell data
            const key = `${dateStr}-${hour}`;
            const existing = cellMap.get(key) || { total: 0, count: 0 };
            cellMap.set(key, {
                total: existing.total + snap.focusQuality,
                count: existing.count + 1,
            });

            // Hourly averages
            if (!hourlyTotals[hour]) {
                hourlyTotals[hour] = { total: 0, count: 0 };
            }
            hourlyTotals[hour].total += snap.focusQuality;
            hourlyTotals[hour].count += 1;

            // Daily averages
            if (!dailyTotals[dayOfWeek]) {
                dailyTotals[dayOfWeek] = { total: 0, count: 0 };
            }
            dailyTotals[dayOfWeek].total += snap.focusQuality;
            dailyTotals[dayOfWeek].count += 1;
        }

        // Convert to arrays/records
        const cells = Array.from(cellMap.entries()).map(([key, value]) => {
            const [_date, _hourStr] =
                key.split("-").length > 3
                    ? [key.slice(0, 10), parseInt(key.slice(11), 10)]
                    : [key.slice(0, 10), parseInt(key.slice(11), 10)];
            return {
                date: key.slice(0, 10),
                hour: parseInt(key.slice(11), 10),
                focusQuality: value.total / value.count,
                count: value.count,
            };
        });

        const hourlyAverages: Record<number, number> = {};
        for (const [hour, data] of Object.entries(hourlyTotals)) {
            hourlyAverages[parseInt(hour, 10)] = data.total / data.count;
        }

        const dailyAverages: Record<number, number> = {};
        for (const [day, data] of Object.entries(dailyTotals)) {
            dailyAverages[parseInt(day, 10)] = data.total / data.count;
        }

        // Find peak and low times
        let peakTime = { hour: 0, day: 0, quality: 0 };
        let lowTime = { hour: 0, day: 0, quality: 5 };

        for (const cell of cells) {
            const date = new Date(cell.date);
            if (cell.focusQuality > peakTime.quality) {
                peakTime = { hour: cell.hour, day: date.getDay(), quality: cell.focusQuality };
            }
            if (cell.focusQuality < lowTime.quality) {
                lowTime = { hour: cell.hour, day: date.getDay(), quality: cell.focusQuality };
            }
        }

        return {
            cells,
            hourlyAverages,
            dailyAverages,
            peakTime,
            lowTime,
        };
    }

    // ============================================
    // Distraction Operations (Phase 3)
    // ============================================

    async getDistractions(userId: string, options?: DistractionQueryOptions): Promise<Distraction[]> {
        const data = this.readStorage<Record<string, Distraction>>(ASSISTANT_STORAGE_KEYS.DISTRACTIONS) || {};

        let filtered = Object.values(data).filter((d) => d.userId === userId);

        if (options?.source) {
            filtered = filtered.filter((d) => d.source === options.source);
        }
        if (options?.startDate) {
            filtered = filtered.filter((d) => new Date(d.timestamp) >= options.startDate!);
        }
        if (options?.endDate) {
            filtered = filtered.filter((d) => new Date(d.timestamp) <= options.endDate!);
        }

        // Sort by timestamp descending
        filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        if (options?.offset) {
            filtered = filtered.slice(options.offset);
        }
        if (options?.limit) {
            filtered = filtered.slice(0, options.limit);
        }

        return filtered;
    }

    async logDistraction(input: DistractionInput, userId: string): Promise<Distraction> {
        const now = new Date();
        const distraction: Distraction = {
            id: generateDistractionId(),
            userId,
            timestamp: input.timestamp ?? now,
            source: input.source,
            description: input.description,
            duration: input.duration,
            taskInterrupted: input.taskInterrupted,
            resumedTask: input.resumedTask ?? false,
            createdAt: now,
        };

        const data = this.readStorage<Record<string, Distraction>>(ASSISTANT_STORAGE_KEYS.DISTRACTIONS) || {};
        data[distraction.id] = distraction;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.DISTRACTIONS, data);

        this.broadcast({
            type: "DISTRACTION_LOGGED",
            payload: distraction,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        return distraction;
    }

    async getDistractionStats(userId: string, startDate: Date, endDate: Date): Promise<DistractionStats> {
        const distractions = await this.getDistractions(userId, { startDate, endDate });

        const bySource: Record<string, { count: number; duration: number }> = {};
        let totalDuration = 0;
        let resumedCount = 0;

        for (const d of distractions) {
            if (!bySource[d.source]) {
                bySource[d.source] = { count: 0, duration: 0 };
            }
            bySource[d.source].count += 1;
            bySource[d.source].duration += d.duration ?? 0;
            totalDuration += d.duration ?? 0;
            if (d.resumedTask) {
                resumedCount += 1;
            }
        }

        // Calculate days in range
        const daysInRange = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

        // Find most common and disruptive sources
        let mostCommonSource = "";
        let mostCommonCount = 0;
        let mostDisruptiveSource = "";
        let mostDisruptiveDuration = 0;

        for (const [source, data] of Object.entries(bySource)) {
            if (data.count > mostCommonCount) {
                mostCommonCount = data.count;
                mostCommonSource = source;
            }
            if (data.duration > mostDisruptiveDuration) {
                mostDisruptiveDuration = data.duration;
                mostDisruptiveSource = source;
            }
        }

        return {
            totalDistractions: distractions.length,
            totalDurationMinutes: totalDuration,
            bySource,
            averagePerDay: distractions.length / Math.max(daysInRange, 1),
            resumptionRate: distractions.length > 0 ? (resumedCount / distractions.length) * 100 : 0,
            mostCommonSource,
            mostDisruptiveSource,
        };
    }

    // ============================================
    // Weekly Review Operations (Phase 3)
    // ============================================

    async getWeeklyReviews(userId: string, limit?: number): Promise<WeeklyReview[]> {
        const data = this.readStorage<Record<string, WeeklyReview>>(ASSISTANT_STORAGE_KEYS.WEEKLY_REVIEWS) || {};

        let reviews = Object.values(data)
            .filter((r) => r.userId === userId)
            .sort((a, b) => new Date(b.weekStart).getTime() - new Date(a.weekStart).getTime());

        if (limit) {
            reviews = reviews.slice(0, limit);
        }

        return reviews;
    }

    async getWeeklyReview(id: string): Promise<WeeklyReview | null> {
        const data = this.readStorage<Record<string, WeeklyReview>>(ASSISTANT_STORAGE_KEYS.WEEKLY_REVIEWS) || {};
        return data[id] || null;
    }

    async generateWeeklyReview(input: WeeklyReviewInput, userId: string): Promise<WeeklyReview> {
        const now = new Date();

        // Get completions for this week
        const completions = await this.getCompletions(userId, {
            startDate: input.weekStart,
            endDate: input.weekEnd,
        });
        const taskCompletions = completions.filter((c) => c.completionType === "task-complete");

        // Get completions for last week
        const lastWeekStart = new Date(input.weekStart);
        lastWeekStart.setDate(lastWeekStart.getDate() - 7);
        const lastWeekEnd = new Date(input.weekStart);
        lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
        const lastWeekCompletions = await this.getCompletions(userId, {
            startDate: lastWeekStart,
            endDate: lastWeekEnd,
        });
        const lastWeekTaskCompletions = lastWeekCompletions.filter((c) => c.completionType === "task-complete");

        // Get energy data
        const energyData = await this.getEnergyHeatmapData(userId, input.weekStart, input.weekEnd);
        const energySnapshots = await this.getEnergySnapshots(userId, {
            startDate: input.weekStart,
            endDate: input.weekEnd,
        });

        // Calculate energy by day
        const energyByDay: Record<string, number> = {};
        for (const snap of energySnapshots) {
            const dateStr = new Date(snap.timestamp).toISOString().split("T")[0];
            if (!energyByDay[dateStr]) {
                energyByDay[dateStr] = 0;
            }
            energyByDay[dateStr] += snap.focusQuality;
        }

        // Calculate time totals
        const totalMinutes = taskCompletions.reduce((sum, c) => sum + (c.metadata.focusTimeSpent ?? 0), 0);
        const deepFocusSnapshots = energySnapshots.filter((e) => e.typeOfWork === "deep-work");
        const meetingSnapshots = energySnapshots.filter((e) => e.typeOfWork === "meeting");

        // Get streak and badges
        const streak = await this.getStreak(userId);
        const badges = await this.getBadges(userId);
        const weekBadges = badges.filter(
            (b) => new Date(b.earnedAt) >= input.weekStart && new Date(b.earnedAt) <= input.weekEnd
        );

        // Calculate deadline stats (tasks with deadlines in this week)
        const tasks = await this.getTasks(userId);
        const tasksWithDeadlines = tasks.filter(
            (t) => t.deadline && new Date(t.deadline) >= input.weekStart && new Date(t.deadline) <= input.weekEnd
        );
        const deadlinesHit = tasksWithDeadlines.filter((t) => t.status === "completed").length;

        // Generate insights
        const insights: string[] = [];
        if (taskCompletions.length > lastWeekTaskCompletions.length) {
            insights.push(
                `Completed ${taskCompletions.length - lastWeekTaskCompletions.length} more tasks than last week`
            );
        }
        if (energyData.peakTime.quality > 0) {
            const peakHour = energyData.peakTime.hour;
            const peakDay = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
                energyData.peakTime.day
            ];
            insights.push(`Peak focus time: ${peakDay}s around ${peakHour}:00`);
        }
        if (deepFocusSnapshots.length > 0) {
            insights.push(`${deepFocusSnapshots.length} deep work sessions logged`);
        }

        // Generate recommendations
        const recommendations: string[] = [];
        if (energyData.lowTime.quality < 3) {
            recommendations.push("Consider scheduling lighter tasks during low energy periods");
        }
        if (meetingSnapshots.length > deepFocusSnapshots.length) {
            recommendations.push("Try to protect more time for deep work");
        }
        if (taskCompletions.length < 5) {
            recommendations.push("Break larger tasks into smaller, completable chunks");
        }

        const review: WeeklyReview = {
            id: generateWeeklyReviewId(),
            userId,
            weekStart: input.weekStart,
            weekEnd: input.weekEnd,
            tasksCompleted: taskCompletions.length,
            tasksCompletedLastWeek: lastWeekTaskCompletions.length,
            deadlinesHit,
            deadlinesTotal: tasksWithDeadlines.length,
            totalMinutes,
            deepFocusMinutes: deepFocusSnapshots.length * 30, // Estimate 30 min per snapshot
            meetingMinutes: meetingSnapshots.length * 30,
            averageEnergy:
                energySnapshots.length > 0
                    ? energySnapshots.reduce((sum, e) => sum + e.focusQuality, 0) / energySnapshots.length
                    : 0,
            energyByDay,
            peakFocusTime: `${energyData.peakTime.hour}:00`,
            lowEnergyTime: `${energyData.lowTime.hour}:00`,
            insights,
            recommendations,
            badgesEarned: weekBadges.map((b) => b.badgeType),
            streakDays: streak?.currentStreakDays ?? 0,
            generatedAt: now,
            createdAt: now,
        };

        const data = this.readStorage<Record<string, WeeklyReview>>(ASSISTANT_STORAGE_KEYS.WEEKLY_REVIEWS) || {};
        data[review.id] = review;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.WEEKLY_REVIEWS, data);

        this.broadcast({
            type: "WEEKLY_REVIEW_GENERATED",
            payload: review,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        return review;
    }

    async getCurrentWeekReview(userId: string): Promise<WeeklyReview | null> {
        const now = new Date();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
        startOfWeek.setHours(0, 0, 0, 0);

        const reviews = await this.getWeeklyReviews(userId, 1);
        if (reviews.length > 0) {
            const review = reviews[0];
            if (new Date(review.weekStart).getTime() === startOfWeek.getTime()) {
                return review;
            }
        }
        return null;
    }

    // ============================================
    // Celebration Operations (Phase 3)
    // ============================================

    async getPendingCelebrations(userId: string): Promise<Celebration[]> {
        const data = this.readStorage<Record<string, Celebration>>(ASSISTANT_STORAGE_KEYS.CELEBRATIONS) || {};

        return Object.values(data)
            .filter((c) => c.userId === userId && !c.dismissed && !c.shownAt)
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }

    async createCelebration(
        userId: string,
        tier: CelebrationTier,
        title: string,
        message: string,
        triggerType: string,
        triggerId?: string
    ): Promise<Celebration> {
        const now = new Date();
        const celebration: Celebration = {
            id: generateCelebrationId(),
            userId,
            tier,
            title,
            message,
            triggerType: triggerType as Celebration["triggerType"],
            triggerId,
            dismissed: false,
            createdAt: now,
        };

        const data = this.readStorage<Record<string, Celebration>>(ASSISTANT_STORAGE_KEYS.CELEBRATIONS) || {};
        data[celebration.id] = celebration;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.CELEBRATIONS, data);

        this.broadcast({
            type: "CELEBRATION_CREATED",
            payload: celebration,
            timestamp: Date.now(),
            sourceTab: this.tabId,
        });

        const userCelebrations = Object.values(data).filter((c) => c.userId === userId);
        this.notifyCelebrationWatchers(userId, userCelebrations);

        return celebration;
    }

    async markCelebrationShown(id: string): Promise<Celebration> {
        const data = this.readStorage<Record<string, Celebration>>(ASSISTANT_STORAGE_KEYS.CELEBRATIONS) || {};
        const existing = data[id];

        if (!existing) {
            throw new Error(`Celebration ${id} not found`);
        }

        const updated: Celebration = {
            ...existing,
            shownAt: new Date(),
        };

        data[id] = updated;
        this.writeStorage(ASSISTANT_STORAGE_KEYS.CELEBRATIONS, data);

        return updated;
    }

    async dismissCelebration(id: string): Promise<void> {
        const data = this.readStorage<Record<string, Celebration>>(ASSISTANT_STORAGE_KEYS.CELEBRATIONS) || {};
        const celebration = data[id];

        if (celebration) {
            const userId = celebration.userId;
            data[id] = { ...celebration, dismissed: true };
            this.writeStorage(ASSISTANT_STORAGE_KEYS.CELEBRATIONS, data);

            this.broadcast({
                type: "CELEBRATION_DISMISSED",
                payload: { id },
                timestamp: Date.now(),
                sourceTab: this.tabId,
            });

            const userCelebrations = Object.values(data).filter((c) => c.userId === userId);
            this.notifyCelebrationWatchers(userId, userCelebrations);
        }
    }

    async determineCelebrationTier(userId: string, completionType: string): Promise<CelebrationTier> {
        const stats = await this.getCompletionStats(userId);

        // Full celebration for milestones
        if (completionType === "badge-earned") {
            return "badge";
        }

        if (completionType === "streak-milestone") {
            const streakMilestones = [7, 14, 30, 60, 100];
            if (streakMilestones.includes(stats.currentStreak)) {
                return "full";
            }
            return "badge";
        }

        // Task completion celebrations
        const taskMilestones = [10, 25, 50, 100, 200];
        if (taskMilestones.includes(stats.totalTasksCompleted)) {
            return "full";
        }

        // Badge celebration for completing 5 tasks
        if (stats.totalTasksCompleted % 5 === 0) {
            return "badge";
        }

        // Default micro celebration
        return "micro";
    }

    // ============================================
    // Badge Progress Operations (Phase 3)
    // ============================================

    async getBadgeProgress(userId: string): Promise<BadgeProgress[]> {
        const earnedBadges = await this.getBadges(userId);
        const earnedTypes = new Set(earnedBadges.map((b) => b.badgeType));

        const stats = await this.getCompletionStats(userId);
        const communications = await this.getCommunicationEntries(userId);
        const decisions = await this.getDecisions(userId);

        const progress: BadgeProgress[] = [];

        for (const definition of BADGE_DEFINITIONS) {
            if (earnedTypes.has(definition.type)) {
                continue;
            }

            let current = 0;
            const target = definition.requirement.value;

            switch (definition.requirement.type) {
                case "task-count":
                    current = stats.totalTasksCompleted;
                    break;
                case "streak-days":
                    current = stats.currentStreak;
                    break;
                case "first-action":
                    if (definition.requirement.action === "critical-complete") {
                        current = stats.criticalTasksCompleted;
                    }
                    break;
                case "focus-time":
                    current = stats.totalFocusTime;
                    break;
                case "decision-count":
                    current = decisions.length;
                    break;
                case "communication-count":
                    current = communications.length;
                    break;
            }

            progress.push({
                badgeType: definition.type,
                displayName: definition.displayName,
                description: definition.description,
                current,
                target,
                percentComplete: Math.min((current / target) * 100, 100),
                rarity: definition.rarity,
            });
        }

        // Sort by progress (closest to completion first)
        progress.sort((a, b) => b.percentComplete - a.percentComplete);

        return progress;
    }

    // ============================================
    // Watchers
    // ============================================

    watchTasks(userId: string, callback: (tasks: Task[]) => void): () => void {
        const watcherId = `${userId}_${Date.now()}`;
        this.taskWatchers.set(watcherId, callback);

        // Initial call
        this.getTasks(userId).then(callback);

        return () => {
            this.taskWatchers.delete(watcherId);
        };
    }

    watchStreak(userId: string, callback: (streak: Streak | null) => void): () => void {
        const watcherId = `${userId}_${Date.now()}`;
        this.streakWatchers.set(watcherId, callback);

        // Initial call
        this.getStreak(userId).then(callback);

        return () => {
            this.streakWatchers.delete(watcherId);
        };
    }

    watchBadges(userId: string, callback: (badges: Badge[]) => void): () => void {
        const watcherId = `${userId}_${Date.now()}`;
        this.badgeWatchers.set(watcherId, callback);

        // Initial call
        this.getBadges(userId).then(callback);

        return () => {
            this.badgeWatchers.delete(watcherId);
        };
    }

    watchCommunications(userId: string, callback: (entries: CommunicationEntry[]) => void): () => void {
        const watcherId = `${userId}_${Date.now()}`;
        this.communicationWatchers.set(watcherId, callback);

        // Initial call
        this.getCommunicationEntries(userId).then(callback);

        return () => {
            this.communicationWatchers.delete(watcherId);
        };
    }

    watchDecisions(userId: string, callback: (decisions: Decision[]) => void): () => void {
        const watcherId = `${userId}_${Date.now()}`;
        this.decisionWatchers.set(watcherId, callback);

        // Initial call
        this.getDecisions(userId).then(callback);

        return () => {
            this.decisionWatchers.delete(watcherId);
        };
    }

    watchBlockers(userId: string, callback: (blockers: TaskBlocker[]) => void): () => void {
        const watcherId = `${userId}_${Date.now()}`;
        this.blockerWatchers.set(watcherId, callback);

        // Initial call
        this.getBlockers(userId).then(callback);

        return () => {
            this.blockerWatchers.delete(watcherId);
        };
    }

    watchCelebrations(userId: string, callback: (celebrations: Celebration[]) => void): () => void {
        const watcherId = `${userId}_${Date.now()}`;
        this.celebrationWatchers.set(watcherId, callback);

        // Initial call
        this.getPendingCelebrations(userId).then(callback);

        return () => {
            this.celebrationWatchers.delete(watcherId);
        };
    }

    // ============================================
    // Private Helpers
    // ============================================

    private readStorage<T>(key: string): T | null {
        if (typeof localStorage === "undefined") {
            return null;
        }
        try {
            const raw = localStorage.getItem(key);
            if (!raw) {
                return null;
            }
            return JSON.parse(raw, this.dateReviver) as T;
        } catch {
            return null;
        }
    }

    private writeStorage(key: string, data: unknown): void {
        if (typeof localStorage === "undefined") {
            return;
        }
        localStorage.setItem(key, JSON.stringify(data));
    }

    private dateReviver(_key: string, value: unknown): unknown {
        if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
            return new Date(value);
        }
        return value;
    }

    private broadcast(message: AssistantSyncMessage): void {
        if (this.broadcastChannel) {
            this.broadcastChannel.postMessage(message);
        }
    }

    private handleSyncMessage(message: AssistantSyncMessage): void {
        if (message.sourceTab === this.tabId) {
            return;
        }

        switch (message.type) {
            case "TASK_CREATED":
            case "TASK_UPDATED":
            case "TASK_DELETED": {
                const task = message.payload as Task;
                if (task?.userId) {
                    this.notifyTaskWatchers(task.userId);
                }
                break;
            }
            case "STREAK_UPDATED": {
                const streak = message.payload as Streak;
                if (streak?.userId) {
                    this.notifyStreakWatchers(streak.userId, streak);
                }
                break;
            }
            case "BADGE_EARNED": {
                const badge = message.payload as Badge;
                if (badge?.userId) {
                    this.getBadges(badge.userId).then((badges) => {
                        this.notifyBadgeWatchers(badge.userId, badges);
                    });
                }
                break;
            }
            case "COMMUNICATION_CREATED":
            case "COMMUNICATION_UPDATED":
            case "COMMUNICATION_DELETED": {
                const entry = message.payload as CommunicationEntry;
                if (entry?.userId) {
                    this.getCommunicationEntries(entry.userId).then((entries) => {
                        this.notifyCommunicationWatchers(entry.userId, entries);
                    });
                }
                break;
            }
            case "DECISION_CREATED":
            case "DECISION_UPDATED":
            case "DECISION_DELETED": {
                const decision = message.payload as Decision;
                if (decision?.userId) {
                    this.getDecisions(decision.userId).then((decisions) => {
                        this.notifyDecisionWatchers(decision.userId, decisions);
                    });
                }
                break;
            }
            case "BLOCKER_CREATED":
            case "BLOCKER_UPDATED":
            case "BLOCKER_RESOLVED": {
                const blocker = message.payload as TaskBlocker;
                if (blocker?.userId) {
                    this.getBlockers(blocker.userId).then((blockers) => {
                        this.notifyBlockerWatchers(blocker.userId, blockers);
                    });
                }
                break;
            }
            case "CELEBRATION_CREATED":
            case "CELEBRATION_DISMISSED": {
                const celebration = message.payload as Celebration;
                if (celebration?.userId) {
                    this.getPendingCelebrations(celebration.userId).then((celebrations) => {
                        this.notifyCelebrationWatchers(celebration.userId, celebrations);
                    });
                }
                break;
            }
        }
    }

    private handleStorageEvent(event: StorageEvent): void {
        if (
            event.key === ASSISTANT_STORAGE_KEYS.TASKS ||
            event.key === ASSISTANT_STORAGE_KEYS.STREAKS ||
            event.key === ASSISTANT_STORAGE_KEYS.BADGES ||
            event.key === ASSISTANT_STORAGE_KEYS.COMMUNICATIONS ||
            event.key === ASSISTANT_STORAGE_KEYS.DECISIONS ||
            event.key === ASSISTANT_STORAGE_KEYS.BLOCKERS ||
            event.key === ASSISTANT_STORAGE_KEYS.CELEBRATIONS
        ) {
            // Re-notify all watchers
            for (const callback of this.taskWatchers.values()) {
                const data = this.readStorage<Record<string, Task>>(ASSISTANT_STORAGE_KEYS.TASKS) || {};
                callback(Object.values(data));
            }
        }
    }

    private notifyTaskWatchers(userId: string): void {
        this.getTasks(userId).then((tasks) => {
            for (const callback of this.taskWatchers.values()) {
                callback(tasks);
            }
        });
    }

    private notifyTaskWatchersDirect(tasks: Task[]): void {
        for (const callback of this.taskWatchers.values()) {
            callback(tasks);
        }
    }

    private notifyStreakWatchers(_userId: string, streak: Streak | null): void {
        for (const callback of this.streakWatchers.values()) {
            callback(streak);
        }
    }

    private notifyBadgeWatchers(_userId: string, badges: Badge[]): void {
        for (const callback of this.badgeWatchers.values()) {
            callback(badges);
        }
    }

    private notifyCommunicationWatchers(_userId: string, entries: CommunicationEntry[]): void {
        for (const callback of this.communicationWatchers.values()) {
            callback(entries);
        }
    }

    private notifyDecisionWatchers(_userId: string, decisions: Decision[]): void {
        for (const callback of this.decisionWatchers.values()) {
            callback(decisions);
        }
    }

    private notifyBlockerWatchers(_userId: string, blockers: TaskBlocker[]): void {
        for (const callback of this.blockerWatchers.values()) {
            callback(blockers);
        }
    }

    private notifyCelebrationWatchers(_userId: string, celebrations: Celebration[]): void {
        for (const callback of this.celebrationWatchers.values()) {
            callback(celebrations);
        }
    }

    private pruneCompletions(entries: CompletionEvent[]): CompletionEvent[] {
        // Limit by count
        let pruned = entries
            .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
            .slice(0, ASSISTANT_SYNC_CONFIG.MAX_COMPLETION_ENTRIES);

        // Limit by age
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - ASSISTANT_SYNC_CONFIG.COMPLETION_RETENTION_DAYS);

        pruned = pruned.filter((e) => new Date(e.completedAt) >= cutoff);

        return pruned;
    }
}
