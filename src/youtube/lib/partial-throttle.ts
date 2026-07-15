export interface PartialThrottleOpts<T> {
    /** Minimum gap between emissions, in milliseconds. */
    minGapMs: number;
    emit: (value: T) => void;
}

export interface PartialThrottle<T> {
    push(value: T): void;
    flush(): void;
}

/**
 * Latest-wins throttle for streaming partials: `push` emits immediately when the
 * gap since the last emission is ≥ `minGapMs`, otherwise keeps only the newest
 * value and timer-flushes it once the gap elapses. `flush()` synchronously
 * delivers the last pushed value if (and only if) it has not been emitted yet.
 */
export function createPartialThrottle<T>(opts: PartialThrottleOpts<T>): PartialThrottle<T> {
    const { minGapMs, emit } = opts;
    let lastEmitAt = Number.NEGATIVE_INFINITY;
    let pending: { value: T } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function clearTimer(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function emitNow(value: T): void {
        lastEmitAt = Date.now();
        pending = null;
        emit(value);
    }

    return {
        push(value: T): void {
            const elapsed = Date.now() - lastEmitAt;

            if (elapsed >= minGapMs) {
                clearTimer();
                emitNow(value);
                return;
            }

            pending = { value };

            if (timer === null) {
                timer = setTimeout(() => {
                    timer = null;

                    if (pending) {
                        emitNow(pending.value);
                    }
                }, minGapMs - elapsed);
            }
        },
        flush(): void {
            clearTimer();

            if (pending) {
                emitNow(pending.value);
            }
        },
    };
}
