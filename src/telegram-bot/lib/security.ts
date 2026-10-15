const GLOBAL_LIMIT = 20;
const WINDOW_MS = 60_000;

const commandCooldowns = new Map<string, number>([
    ["tools", 5_000],
    ["run", 10_000],
]);

export interface RateLimitResult {
    allowed: boolean;
    retryAfterMs?: number;
}

export interface RateLimiter {
    check(command: string): RateLimitResult;
}

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
    let timestamps: number[] = [];
    // Only the commands that have a cooldown are remembered, so an arbitrary command string never grows this map.
    const lastCommandTime = new Map<string, number>();

    return {
        check(command) {
            const current = now();

            timestamps = timestamps.filter((t) => current - t < WINDOW_MS);
            if (timestamps.length >= GLOBAL_LIMIT) {
                return { allowed: false, retryAfterMs: WINDOW_MS - (current - timestamps[0]) };
            }

            const cooldownMs = commandCooldowns.get(command);
            const lastTime = lastCommandTime.get(command);
            if (cooldownMs !== undefined && lastTime !== undefined && current - lastTime < cooldownMs) {
                return { allowed: false, retryAfterMs: cooldownMs - (current - lastTime) };
            }

            timestamps.push(current);
            if (cooldownMs !== undefined) {
                lastCommandTime.set(command, current);
            }

            return { allowed: true };
        },
    };
}
