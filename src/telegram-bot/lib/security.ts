const GLOBAL_LIMIT = 20;
const WINDOW_MS = 60_000;

const commandCooldowns: Record<string, number> = {
    tools: 5_000,
    run: 10_000,
};

interface RateLimitState {
    timestamps: number[];
    lastCommandTime: Record<string, number>;
}

const state: RateLimitState = {
    timestamps: [],
    lastCommandTime: {},
};

export function checkRateLimit(command: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();

    state.timestamps = state.timestamps.filter((t) => now - t < WINDOW_MS);
    if (state.timestamps.length >= GLOBAL_LIMIT) {
        const oldest = state.timestamps[0];
        return { allowed: false, retryAfterMs: WINDOW_MS - (now - oldest) };
    }

    const cooldownMs = commandCooldowns[command];
    if (cooldownMs) {
        const lastTime = state.lastCommandTime[command] ?? 0;
        if (now - lastTime < cooldownMs) {
            return { allowed: false, retryAfterMs: cooldownMs - (now - lastTime) };
        }
    }

    state.timestamps.push(now);
    state.lastCommandTime[command] = now;
    return { allowed: true };
}
