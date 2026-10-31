const INTERPRETER_OPTIONS_WITH_VALUE = new Set([
    "-r",
    "--require",
    "--preload",
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

/** Options that make the interpreter run something other than a script operand: eval, print, a syntax check, a REPL. */
const INTERPRETER_MODES = new Set([
    "-e",
    "--eval",
    "-p",
    "--print",
    "-c",
    "--check",
    "-i",
    "--interactive",
    "--test",
    "-h",
    "--help",
    "-v",
    "--version",
]);

/**
 * Find a known script after Node or Bun options. A process line is flattened argv, so an option the parser does not
 * know may or may not take the next word as its value: the next word is checked as the script, and when it is not
 * the script it is read as that option's value. Eval, print and the other modes that run no script give no boundary.
 */
export function interpreterScriptIndex(command: string, matchesScript: (arg: string) => boolean): number | null {
    const args = command.trim().split(/\s+/).slice(1);
    let mayBeValue = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            return matchesScript(args[i + 1] ?? "") ? i + 2 : null;
        }

        if (INTERPRETER_MODES.has(arg) || [...INTERPRETER_MODES].some((mode) => arg.startsWith(`${mode}=`))) {
            return null;
        }

        if (INTERPRETER_OPTIONS_WITH_VALUE.has(arg)) {
            i++;
            mayBeValue = false;
            continue;
        }

        if (
            INTERPRETER_FLAGS.has(arg) ||
            [...INTERPRETER_OPTIONS_WITH_VALUE].some((option) => arg.startsWith(`${option}=`))
        ) {
            mayBeValue = false;
            continue;
        }

        if (arg.startsWith("-")) {
            mayBeValue = !arg.includes("=");
            continue;
        }

        if (matchesScript(arg)) {
            return i + 1;
        }

        if (!mayBeValue) {
            return null;
        }

        mayBeValue = false;
    }

    return null;
}
