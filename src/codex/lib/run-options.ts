import { validateTuiArgs } from "./launch-options";

export interface CodexRunOptions {
    cwd?: string;
    home?: string;
    computerUse?: boolean;
    model?: string;
    resume?: string | boolean;
    /** `-c, --continue`: `codex resume --last`. */
    continue?: boolean;
    all?: boolean;
}

export function buildNativeRunArgs(input: { args: string[]; options: CodexRunOptions; sessionId?: string }): string[] {
    const { args, options, sessionId } = input;
    const native = validateTuiArgs(args);
    if (options.model && native.some((arg) => /^(?:--model|-m)(?:=|$)/.test(arg))) {
        throw new Error("Specify --model once, through the wrapper or native arguments");
    }
    if ((options.resume || options.continue) && (native[0] === "resume" || native[0] === "fork")) {
        throw new Error("Specify --resume or a native resume/fork command, not both");
    }
    if (options.resume && options.continue) {
        throw new Error("Specify --resume or --continue, not both");
    }
    if (typeof options.resume === "string" && !sessionId) {
        throw new Error("Resume query must be resolved to a session before launching Codex");
    }
    const resuming = (options.resume !== undefined && options.resume !== false) || options.continue === true;
    if (options.all && !options.resume && native[0] !== "resume") {
        throw new Error("--all requires --resume or a native resume command");
    }
    const model = options.model ? ["--model", options.model] : [];
    if (!resuming) {
        return [...model, ...native, ...(options.all ? ["--all"] : [])];
    }
    return [
        ...model,
        "resume",
        ...(sessionId ? [sessionId] : options.continue ? ["--last"] : []),
        ...(options.all ? ["--all"] : []),
        ...native,
    ];
}
