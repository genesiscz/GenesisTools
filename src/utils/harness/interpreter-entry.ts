const INTERPRETER_OPTIONS_WITH_VALUE = new Set([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--conditions",
    "-C",
    "--env-file",
    "--env-file-if-exists",
    "--inspect-port",
]);
const INTERPRETER_FLAGS = new Set([
    "--no-warnings",
    "--trace-warnings",
    "--trace-uncaught",
    "--enable-source-maps",
    "--inspect",
    "--inspect-brk",
    "--smol",
]);

/** Find a known script after supported Node or Bun options. Unknown options do not establish a boundary. */
export function interpreterScriptIndex(command: string, matchesScript: (arg: string) => boolean): number | null {
    const args = command.trim().split(/\s+/).slice(1);

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            return matchesScript(args[i + 1] ?? "") ? i + 2 : null;
        }

        if (INTERPRETER_OPTIONS_WITH_VALUE.has(arg)) {
            i++;
            continue;
        }

        if (
            INTERPRETER_FLAGS.has(arg) ||
            [...INTERPRETER_OPTIONS_WITH_VALUE].some((option) => arg.startsWith(`${option}=`))
        ) {
            continue;
        }

        return matchesScript(arg) ? i + 1 : null;
    }

    return null;
}
