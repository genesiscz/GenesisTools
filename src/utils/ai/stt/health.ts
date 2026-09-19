import type { SttProviderId } from "./types";

export const STT_HEARTBEAT_TIMEOUT_MS = 8_000;

/** True when audio keeps flowing but the provider has said nothing for `timeoutMs`. */
export function shouldReconnect(options: {
    lastEventMs: number;
    audioFlowing: boolean;
    now: number;
    timeoutMs?: number;
}): boolean {
    if (!options.audioFlowing) {
        return false;
    }

    return options.now - options.lastEventMs >= (options.timeoutMs ?? STT_HEARTBEAT_TIMEOUT_MS);
}

/** The provider to switch to after a failed heartbeat, or null when no switch is allowed. */
export function nextFallback(current: SttProviderId, fallback?: SttProviderId): SttProviderId | null {
    if (!fallback || fallback === current || fallback === "fixture") {
        return null;
    }

    return fallback;
}

export interface ReconnectState {
    attempts: number;
}

export const MAX_SESSION_RECONNECTS = 1;

export function recordReconnect(state: ReconnectState): { retry: boolean; attempts: number } {
    state.attempts += 1;
    return { retry: state.attempts <= MAX_SESSION_RECONNECTS, attempts: state.attempts };
}
