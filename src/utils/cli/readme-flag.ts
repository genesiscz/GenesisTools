/**
 * The `--readme` check every entry shares. It stays a leaf on purpose: the README renderer (cli-html and
 * highlight.js, about 590 modules) loads only when argv asks for it, so a tool's cold start never pays for it.
 */

/** True when argv asks for the README before a "--" separator. */
export function argvRequestsReadme(args: readonly string[]): boolean {
    // Stop at the conventional `--` separator: everything after it is meant
    // for a wrapped child command (e.g. `tools task run -- bash --readme`),
    // not for the wrapper itself. Scanning past it caused the wrapper to
    // hijack any child whose own flags happened to include --readme.
    for (const arg of args) {
        if (arg === "--") {
            return false;
        }

        if (arg === "--readme" || arg.startsWith("--readme=")) {
            return true;
        }
    }

    return false;
}

/** Prints the caller's README and exits when argv asks for it; loads the renderer only then. */
export async function answerReadmeFlag(
    callerDir: string,
    argv: readonly string[] = process.argv.slice(2)
): Promise<void> {
    if (!argvRequestsReadme(argv)) {
        return;
    }

    const { printReadmeAndExit } = await import("@genesiscz/utils/readme");
    printReadmeAndExit(callerDir);
}
