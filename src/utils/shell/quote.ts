/**
 * POSIX single-quoting for a value going into a `sh -c` string.
 *
 * Two private copies of this already existed (`terminal/locale.ts`,
 * `cmux/workspace.ts`) and a third was about to be written for the usage daemon,
 * whose task command is executed as `Bun.spawn(["sh", "-c", task.command])`.
 * A checkout or a Bun install under a directory containing a space registered
 * fine and then failed on every run (PR #368 review t5).
 *
 * Single quotes are the only POSIX form with no escapes inside, so every byte
 * survives except a single quote itself, which is closed, escaped and reopened.
 * The result is always quoted, including for an empty string, where an unquoted
 * value would vanish from the argument list entirely.
 */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/** `shellQuote` for a whole argv, joined into one `sh -c` command line. */
export function shellCommandLine(argv: readonly string[]): string {
    return argv.map(shellQuote).join(" ");
}
