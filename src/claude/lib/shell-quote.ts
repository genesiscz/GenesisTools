/**
 * POSIX single-quote one argument for a `sh -c` / tmux `send-keys` string.
 *
 * Everything inside single quotes is literal to the shell, so the only character
 * needing care is `'` itself: close the quote, emit an escaped quote, reopen.
 * Used wherever we hand a command line to a shell we do not control — a teammate
 * wrapper's `exec`, `tools cc run` launch strings, the `claude` launch suffix.
 */
export function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
