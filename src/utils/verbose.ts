/**
 * Factory for creating scoped verbose loggers.
 */

export interface VerboseLogger {
    readonly verbose: boolean;
    setVerbose(v: boolean): void;
    log(...args: unknown[]): void;
}

/**
 * Create a scoped verbose logger.
 * Outputs to stderr when enabled, prefixed with `[label]`.
 */
export function createVerboseLogger(label?: string): VerboseLogger {
    let enabled = false;
    const prefix = label ? `[${label}]` : "[verbose]";
    return {
        get verbose() {
            return enabled;
        },
        setVerbose(v: boolean) {
            enabled = v;
        },
        log(...args: unknown[]) {
            if (enabled) {
                console.error(prefix, ...args);
            }
        },
    };
}
