export interface CursorArgs {
    mode: string;
    model: string | undefined;
    workspace: string;
    raw: boolean;
    help: boolean;
    question: string;
}

export type ParsedCursorArgs = { ok: true; args: CursorArgs } | { ok: false; message: string };

/** The Cursor CLI's own modes. */
export const CURSOR_MODES: readonly string[] = ["ask", "plan"];

const VALUE_OPTIONS = new Set(["--mode", "--model", "--workspace"]);

/** A word that names an option (`-x`, `--model`). A lone `-` does not. */
function isOptionToken(token: string): boolean {
    return token.startsWith("-") && token.length > 1;
}

/**
 * `tools cursor` arguments. An option takes its value as `--mode plan` or `--mode=plan`. A missing value, a
 * spaced value that looks like an option (`--model -x`), or an option this tool does not have (a long one or a
 * short one such as `-x`) is refused, never ignored, so a typo cannot quietly become the question. `--` ends
 * the options: the words after it are the question, even when one of them starts with a dash.
 */
export function parseCursorArgs(argv: string[], cwd: string): ParsedCursorArgs {
    const args: CursorArgs = { mode: "ask", model: undefined, workspace: cwd, raw: false, help: false, question: "" };
    const endOfOptions = argv.indexOf("--");
    const optionArgs = endOfOptions === -1 ? argv : argv.slice(0, endOfOptions);

    if (optionArgs.includes("--help") || optionArgs.includes("-h")) {
        return { ok: true, args: { ...args, help: true } };
    }

    const positional: string[] = [];
    let optionsEnded = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (optionsEnded) {
            positional.push(arg);
            continue;
        }

        if (arg === "--") {
            optionsEnded = true;
            continue;
        }

        const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
        const name = equals === -1 ? arg : arg.slice(0, equals);

        if (arg === "--raw") {
            args.raw = true;
            continue;
        }

        if (VALUE_OPTIONS.has(name)) {
            const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);

            if (value === undefined || value === "" || (equals === -1 && isOptionToken(value))) {
                return { ok: false, message: `${name} needs a value.` };
            }

            if (name === "--mode") {
                args.mode = value;
            } else if (name === "--model") {
                args.model = value;
            } else {
                args.workspace = value;
            }

            continue;
        }

        if (isOptionToken(arg)) {
            return { ok: false, message: `Unknown option ${name}.` };
        }

        positional.push(arg);
    }

    if (!CURSOR_MODES.includes(args.mode)) {
        return {
            ok: false,
            message: `Unknown --mode '${args.mode}'. The Cursor CLI accepts: ${CURSOR_MODES.join(", ")}.`,
        };
    }

    return { ok: true, args: { ...args, question: positional.join(" ").trim() } };
}
