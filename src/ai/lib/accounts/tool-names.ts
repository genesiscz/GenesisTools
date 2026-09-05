/**
 * The sibling command name for a door, e.g. `tools claude login` from
 * `tools claude login-long`.
 *
 * A door names itself with its own verb (`tools ai accounts login-secondary`),
 * so a message that points at `login` cannot just append the word: doing that
 * printed `Run tools claude login-long login first` where the old command said
 * `Run tools claude login first` (gap/cli).
 */
export function siblingCommandOf(tool: string, verb: string): string {
    const trimmed = tool.trim();
    const cut = trimmed.lastIndexOf(" ");

    if (cut < 0) {
        return `${trimmed} ${verb}`;
    }

    return `${trimmed.slice(0, cut)} ${verb}`;
}
