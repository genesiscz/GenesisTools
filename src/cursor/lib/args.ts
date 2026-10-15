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

/**
 * `tools cursor` arguments. An option takes its value as `--mode plan` or `--mode=plan`; a missing value or an
 * option this tool does not have is refused, never ignored, so a typo cannot quietly run another mode.
 */
export function parseCursorArgs(argv: string[], cwd: string): ParsedCursorArgs {
    const args: CursorArgs = { mode: "ask", model: undefined, workspace: cwd, raw: false, help: false, question: "" };

    if (argv.includes("--help") || argv.includes("-h")) {
        return { ok: true, args: { ...args, help: true } };
    }

    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
        const name = equals === -1 ? arg : arg.slice(0, equals);

        if (arg === "--raw") {
            args.raw = true;
            continue;
        }

        if (VALUE_OPTIONS.has(name)) {
            const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);

            if (value === undefined || value === "" || (equals === -1 && value.startsWith("--"))) {
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

        if (arg.startsWith("--")) {
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
