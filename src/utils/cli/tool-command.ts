/**
 * A `tools …` command line for hint text: `toolCommand("macos permissions build")` is
 * `tools macos permissions build`. `command` holds only the tool and its subcommand words, and
 * `args` the flags and values. Hint text names commands through this helper (or `suggestCommand`)
 * so `scripts/ci/check-tool-commands.ts` can fail when a named command was renamed or removed.
 */
export function toolCommand(command: string, ...args: string[]): string {
    const quoted = args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg));

    return ["tools", command, ...quoted].join(" ");
}
