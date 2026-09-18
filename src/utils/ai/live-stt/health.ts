import type { LiveSttProviderId } from "./types";

export function shouldReconnect(options: {
    lastEventMs: number;
    audioFlowing: boolean;
    now: number;
    timeoutMs?: number;
}): boolean {
    if (!options.audioFlowing) {
        return false;
    }
    return options.now - options.lastEventMs >= (options.timeoutMs ?? 8000);
}

export function nextFallback(current: LiveSttProviderId, fallback?: LiveSttProviderId): LiveSttProviderId | null {
    if (!fallback || fallback === current || fallback === "mock") {
        return null;
    }
    return fallback;
}

export interface ReconnectState {
    attempts: number;
}

export function recordReconnect(state: ReconnectState): { retry: boolean; attempts: number } {
    state.attempts += 1;
    return { retry: state.attempts <= 1, attempts: state.attempts };
}
