export interface BenchmarkCommand {
    label: string;
    cmd: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    env?: Record<string, string>;
}

export interface BenchmarkSuite {
    name: string;
    commands: BenchmarkCommand[];
    builtIn?: boolean;
    runs?: number;
    warmup?: number;
    setup?: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    cwd?: string;
    env?: Record<string, string>;
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
    warmup?: number | false;
    noWarmup?: boolean;
    only?: string;
    setup?: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    cwd?: string;
}

export interface AddOptions {
    runs?: number;
    warmup?: number;
    setup?: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    cwd?: string;
    prepareFor?: string[];
    concludeFor?: string[];
    cleanupFor?: string[];
    env?: string[];
    envFor?: string[];
}

export interface EditOptions {
    runs?: number;
    warmup?: number;
    setup?: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    cwd?: string;
    env?: string[];
    clearSetup?: boolean;
    clearPrepare?: boolean;
    clearConclude?: boolean;
    clearCleanup?: boolean;
    clearCwd?: boolean;
    clearEnv?: boolean;
    addCmd?: string[];
    removeCmd?: string[];
    prepareFor?: string[];
    concludeFor?: string[];
    cleanupFor?: string[];
    envFor?: string[];
}

export interface HistoryOptions {
    limit?: number;
    compare?: string;
}
