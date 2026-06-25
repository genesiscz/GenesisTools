import chalk from "chalk";

/**
 * Plain status writes for `tools stash`. We deliberately bypass `out.log.*` (which wraps every
 * line in clack's task-lifecycle box-drawing: `│ ◆ ●`) because that's the wrong texture for a CLI
 * that prints many short status lines per command. Interactive PROMPTS still use @clack/prompts.
 *
 * All status goes to STDERR so `tools stash show --diff > foo.diff` (and similar) still capture
 * only the machine-readable payload via `out.print` / `out.result`.
 */

function write(line: string): void {
    process.stderr.write(`${line}\n`);
}

export const ui = {
    ok(msg: string): void {
        write(`${chalk.green("✓")} ${msg}`);
    },
    info(msg: string): void {
        write(`${chalk.cyan("ℹ")} ${msg}`);
    },
    warn(msg: string): void {
        write(`${chalk.yellow("⚠")} ${msg}`);
    },
    err(msg: string): void {
        write(`${chalk.red("✗")} ${msg}`);
    },
    dim(msg: string): void {
        write(chalk.dim(msg));
    },
    header(msg: string): void {
        write(chalk.bold(msg));
    },
    /** Print a 2-column key/value pair, right-padded key for tidy alignment. */
    kv(key: string, value: string, keyWidth = 9): void {
        write(`  ${chalk.dim(key.padEnd(keyWidth))}${value}`);
    },
    /** Section break — a blank line plus a dim rule. Used before lists/diffs. */
    section(title: string): void {
        write("");
        write(chalk.dim(`── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`));
    },
    /** Bare write to stderr without any chalk decoration. */
    raw(msg: string): void {
        write(msg);
    },
};
