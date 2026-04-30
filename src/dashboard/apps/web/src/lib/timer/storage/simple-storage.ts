/**
 * Simple Server-First Storage Adapter
 *
 * No PowerSync, no IndexedDB complexity.
 * Just direct server calls with optimistic UI updates.
 */

import type { ActivityLogEntry, StorageAdapter, Timer, TimerInput, TimerUpdate } from "@dashboard/shared";
import { getEventClient } from "@/lib/events/client";
import {
    createTimerOnServer,
    deleteTimerOnServer,
    getActivityLogsFromServer,
    getTimersFromServer,
    logActivityOnServer,
    updateTimerOnServer,
} from "../timer-sync.server";

export class SimpleStorageAdapter implements StorageAdapter {
    private userId: string | null = null;
    private timerWatchers = new Map<string, (timers: Timer[]) => void>();
    private activityWatchers = new Map<string, (logs: ActivityLogEntry[]) => void>();
    private eventUnsubscribe: (() => void) | null = null;

    setUserId(userId: string): void {
        this.userId = userId;

        // Subscribe to SSE events
        const eventClient = getEventClient();
        this.eventUnsubscribe = eventClient.subscribe(`timer:${userId}`, async (event) => {
            console.log("[SimpleStorage] SSE event:", event);

            // Refresh timers from server on any change
            const timers = await getTimersFromServer({ data: userId });

            // Notify all watchers
            for (const callback of this.timerWatchers.values()) {
                callback(timers);
            }
        });
    }

    async createTimer(input: TimerInput, userId: string): Promise<Timer> {
        const timer = await createTimerOnServer({ data: { ...input, userId } });
        return timer;
    }

    async getTimers(userId: string): Promise<Timer[]> {
        const timers = await getTimersFromServer({ data: userId });
        return timers;
    }

    async getTimer(id: string): Promise<Timer | null> {
        // Could optimize with a getTimerById server function
        // For now, fetch all and filter
        if (!this.userId) {
            return null;
        }
        const timers = await this.getTimers(this.userId);
        return timers.find((t) => t.id === id) ?? null;
    }

    async updateTimer(id: string, updates: TimerUpdate): Promise<Timer> {
        const timer = await updateTimerOnServer({ data: { id, updates } });
        return timer;
    }

    async deleteTimer(id: string): Promise<void> {
        await deleteTimerOnServer({ data: id });
    }

    watchTimers(userId: string, callback: (timers: Timer[]) => void): () => void {
        const watcherId = `${userId}_${Date.now()}`;
        this.timerWatchers.set(watcherId, callback);

        // Initial fetch
        getTimersFromServer({ data: userId }).then(callback);

        // Return unsubscribe function
        return () => {
            this.timerWatchers.delete(watcherId);
        };
    }

    async logActivity(entry: Omit<ActivityLogEntry, "id" | "timestamp">): Promise<ActivityLogEntry> {
        const logged = await logActivityOnServer({ data: entry });
        return logged;
    }

    async getActivityLogs(userId: string, timerId?: string): Promise<ActivityLogEntry[]> {
        const logs = await getActivityLogsFromServer({ data: userId });
        return timerId ? logs.filter((l) => l.timerId === timerId) : logs;
    }

    watchActivityLogs(userId: string, callback: (logs: ActivityLogEntry[]) => void, timerId?: string): () => void {
        const watcherId = `${userId}_${timerId ?? "all"}_${Date.now()}`;
        this.activityWatchers.set(watcherId, callback);

        // Initial fetch
        this.getActivityLogs(userId, timerId).then(callback);

        // Return unsubscribe function
        return () => {
            this.activityWatchers.delete(watcherId);
        };
    }

    async clearActivityLog(_userId: string): Promise<void> {
        // Server function needed
        console.warn("[SimpleStorage] clearActivityLog not implemented on server yet");
    }

    clearSync(): void {
        if (this.eventUnsubscribe) {
            this.eventUnsubscribe();
            this.eventUnsubscribe = null;
        }
    }

    broadcast(_message: unknown): void {
        // No-op for server-first approach
        // SSE handles all cross-tab sync
    }
}
