/** `tools.exec_command`'s argument, as Codex declares it; the fields Codex has and this runner ignores pass unread. */
export interface ExecCommandArgs {
    cmd: string;
    workdir?: string;
    shell?: string;
    login?: boolean;
    max_output_tokens?: number;
    /** Accepted and ignored: a command always runs to its end. */
    yield_time_ms?: number;
}

/** `tools.exec_command`'s result, as Codex declares it, plus the shell guard's warning when one fired. */
export interface ExecCommandResult {
    output: string;
    exit_code: number;
    wall_time_seconds: number;
    /** Set when the output was cut: the output's size before the cut, at 4 characters per token. */
    original_token_count?: number;
    /** The shell guard's warning about this command; the command ran. */
    guard_warning?: string;
}

export type ExecCommand = (args: ExecCommandArgs) => Promise<ExecCommandResult>;

/** `store` and `load` of one Claude Code session. */
export interface ExecStore {
    load(key: string): unknown;
    store(key: string, value: unknown): void;
}

/** What the shell guard says about one nested command. */
export type GuardCheck = { outcome: "allow" } | { outcome: "block" | "warn"; message: string; rules: string[] };

export interface CommandGuard {
    check(cmd: string, cwd: string): GuardCheck;
}
