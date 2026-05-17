export interface QuietSpinner {
    start: (msg?: string) => void;
    stop: (msg?: string) => void;
    message: (msg?: string) => void;
}

/**
 * A no-op stand-in for `@clack/prompts` `spinner()`.
 *
 * The clack spinner renders animation frames (`[1G[J◒ …`) on a timer; in a
 * non-TTY / piped context those frames flood stdout/stderr with hundreds of
 * useless lines and can corrupt structured output. Swap in this quiet spinner
 * whenever output is not an interactive TTY (see `isQuietOutput`). Status that
 * still matters in quiet mode should be written explicitly to stderr by the
 * caller, not funnelled through the spinner.
 */
export function createQuietSpinner(): QuietSpinner {
    const noop = (): void => {};

    return { start: noop, stop: noop, message: noop };
}
