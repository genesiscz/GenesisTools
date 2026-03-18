export interface BenchmarkCommand {
    label: string;
    cmd: string;
    prepare?: string;   // per-command: runs before each timing run
    conclude?: string;  // per-command: runs after each timing run
    cleanup?: string;   // per-command: runs after all runs for this command
}

export interface BenchmarkSuite {
    name: string;
    commands: BenchmarkCommand[];
    builtIn?: boolean;
    runs?: number;       // --runs (exact count); omit = hyperfine auto-detect
    warmup?: number;     // --warmup (default: 3 if unset)
    setup?: string;      // --setup (once before all timing runs)
    prepare?: string;    // --prepare (before each timing run, all commands)
    conclude?: string;   // --conclude (after each timing run, all commands)
    cleanup?: string;    // --cleanup (after all runs per command)
}

export interface HyperfineResult {
    command: string;
    mean: number;
    stddev: number;
    median: number;
    user: number;
    system: number;
    min: number;
    max: number;
    times: number[];
}

export interface HyperfineOutput {
    results: HyperfineResult[];
}

export interface SavedResult {
    suite: string;
    date: string;
    results: HyperfineResult[];
}

export interface RunOptions {
    compare?: boolean;
    runs?: number;
    warmup?: number | false;  // false when Commander's --no-warmup is used
    noWarmup?: boolean;
    only?: string;
    setup?: string;
    prepare?: string;
    cleanup?: string;
    failThreshold?: number;   // exit 1 if any command regresses by more than N%
    format?: "table" | "md" | "csv" | "json";
    clipboard?: boolean;
}

export interface AddOptions {
    runs?: number;
    warmup?: number;
    setup?: string;
    prepare?: string;
    cleanup?: string;
    prepareFor?: string[];
}
