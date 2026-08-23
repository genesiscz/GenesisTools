/**
 * True when stdin is a TTY. When false, prompts would hang — callers should
 * suggest CLI flags instead.
 *
 * Lives in its own file so prompt backends can import it without pulling the
 * `@genesiscz/utils/cli` barrel (commander + readme + markdown + highlight.js).
 */
export function isInteractive(): boolean {
    return !!process.stdin.isTTY;
}
