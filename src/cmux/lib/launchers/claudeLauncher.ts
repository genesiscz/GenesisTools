export interface ClaudeLaunch {
    account: string;
    prompt: string;
    name?: string;
    resume?: string;
    model?: string;
    cwd?: string;
    /** cmux surface shape. Not part of the claude argv. */
    surface?: "new" | "split" | "workspace";
    /**
     * Extra argv for `tools claude run`, placed before `--`.
     * `-r` and `-m` stay the structured flags; everything else the caller has goes here.
     */
    runArgs?: string[];
    /** Extra argv for claude itself, placed after `--` and after `-n`, before the prompt. */
    claudeArgs?: string[];
    /** When false, a prompt longer than 8 KB is allowed (a local --prompt-file, not a URL). */
    enforceCap?: boolean;
    /**
     * Absolute path the prompt was read from. The command line then reads the file when it runs,
     * so a long prompt is never typed into the terminal.
     */
    promptFile?: string;
}

const PROMPT_CAP = 8_192;
/** exec() fails with E2BIG once argv and the environment pass ARG_MAX (1 MB on macOS); half leaves room for the environment. */
const ARG_CAP = 512 * 1024;

export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Every element, `""` included: dropping an empty flag value would shift the next argument into its place. */
function pushArgs(into: string[], extra: string[] | undefined): void {
    into.push(...(extra ?? []));
}

export function buildClaudeArgv(input: ClaudeLaunch): string[] {
    const bytes = Buffer.byteLength(input.prompt, "utf8");
    const cap = input.enforceCap === false ? ARG_CAP : PROMPT_CAP;

    if (bytes > cap) {
        throw new Error(
            `prompt is ${bytes} bytes; the cap is ${cap}${cap === ARG_CAP ? " (the exec argument limit)" : ""}`
        );
    }

    const args = ["tools", "claude", "run", input.account];

    if (input.resume) {
        args.push("-r", input.resume);
    }

    if (input.model) {
        args.push("-m", input.model);
    }

    pushArgs(args, input.runArgs);
    args.push("--");

    if (input.name) {
        args.push("-n", input.name);
    }

    pushArgs(args, input.claudeArgs);
    args.push(input.prompt);
    return args;
}

/** One quoted command line cmux can type into a new surface. */
export function buildCmuxCommand(input: ClaudeLaunch): string {
    const cd = input.cwd ? `cd ${shellQuote(input.cwd)} && ` : "";
    const argv = buildClaudeArgv(input).map(shellQuote);

    if (input.promptFile) {
        argv[argv.length - 1] = `"$(cat ${shellQuote(input.promptFile)})"`;
    }

    return `${cd}${argv.join(" ")}`;
}
