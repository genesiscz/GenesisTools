/**
 * Suppress specific console.warn messages during noisy operations.
 * Used to silence repeated warnings from libraries like @huggingface/transformers.
 */

export interface WarningSuppressionOptions {
    /** Messages to suppress (partial match) */
    patterns: string[];
    /** Show the first occurrence of each pattern. Default: true */
    showFirst?: boolean;
}

/**
 * Monkey-patch console.warn to suppress specific messages.
 * Returns a restore function — always call it in a finally block.
 *
 * ```typescript
 * const restore = suppressConsoleWarnings({
 *     patterns: ["Unable to determine content-length"],
 * });
 * try {
 *     await noisyOperation();
 * } finally {
 *     restore();
 * }
 * ```
 */
// Global tracking — patterns shown once stay suppressed across calls
const globalSeen = new Map<string, number>();

export function suppressConsoleWarnings(options: WarningSuppressionOptions): () => void {
    const original = console.warn;
    const showFirst = options.showFirst ?? true;

    console.warn = (...args: unknown[]) => {
        const msg = args.map(String).join(" ");

        for (const pattern of options.patterns) {
            if (msg.includes(pattern)) {
                const count = globalSeen.get(pattern) ?? 0;
                globalSeen.set(pattern, count + 1);

                if (count === 0 && showFirst) {
                    original.call(console, ...args);
                }

                return;
            }
        }

        original.call(console, ...args);
    };

    return () => {
        console.warn = original;
    };
}
