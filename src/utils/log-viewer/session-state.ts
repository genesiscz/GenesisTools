import { ACTIVE_THRESHOLD_MS as DBG_ACTIVE_THRESHOLD_MS, SessionManager } from "@app/debugging-master/core/session-manager";
import { formatSessionState } from "@app/task/lib/format-session-state";
import { ACTIVE_THRESHOLD_MS as TASK_ACTIVE_THRESHOLD_MS, TaskSessionStore } from "@app/task/lib/session-store";
import type { DashboardSessionState, LogSourceId } from "./log-source";

export interface ResolvedSessionState {
    state: DashboardSessionState;
    stateLabel: string;
}

export async function resolveSessionState(source: LogSourceId, name: string): Promise<ResolvedSessionState> {
    if (source === "task") {
        return resolveTaskSessionState(name);
    }

    return resolveDbgSessionState(name);
}

async function resolveTaskSessionState(name: string): Promise<ResolvedSessionState> {
    const store = new TaskSessionStore();
    const meta = await store.reconcileSessionState(name);

    if (!meta) {
        return { state: "unknown", stateLabel: "unknown" };
    }

    const label = formatSessionState(meta);

    if (meta.exitCode !== undefined) {
        return { state: "exited", stateLabel: label };
    }

    if (Date.now() - meta.lastActivityAt < TASK_ACTIVE_THRESHOLD_MS) {
        return { state: "active", stateLabel: label };
    }

    return { state: "exited", stateLabel: "idle" };
}

async function resolveDbgSessionState(name: string): Promise<ResolvedSessionState> {
    const manager = new SessionManager();
    const meta = await manager.getSessionMeta(name);

    if (!meta) {
        return { state: "unknown", stateLabel: "unknown" };
    }

    if (Date.now() - meta.lastActivityAt < DBG_ACTIVE_THRESHOLD_MS) {
        return { state: "active", stateLabel: "active" };
    }

    return { state: "exited", stateLabel: "idle" };
}
