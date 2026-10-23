import { afterAll, beforeAll, spyOn } from "bun:test";

/**
 * For the rest of the test file, every synchronous `git` start answers "not a git repository" (exit 128)
 * without starting a process. Other programs still start for real.
 *
 * Bun 1.4.2 under `bun test --parallel` on Linux now and then loses a child's exit (oven-sh/bun#43697, open).
 * The worker that hits it waits on that child, and every later test of the file runs to its 20 s timeout. A
 * decision post reads the poster's checkout with eight `git` starts, about 400 in the decision store tests
 * alone. On 2026-10-19 and 2026-10-22 six CI runs hung that way in the store, inbox or drafts tests, each first
 * timeout inside a post, and the timeouts used up the job's budget, so the suite never finished.
 *
 * Outside a checkout the poster falls back to its cwd, which is what these tests need. The git reads have
 * their own tests in `src/utils/agent/`.
 */
export interface GitWithoutSpawns {
    /** How many `git` starts the stub answered. */
    readonly answered: number;
    /** Every other command, which was started for real. */
    readonly started: readonly string[][];
}

const NOT_A_REPOSITORY = {
    exitCode: 128,
    signalCode: undefined,
    success: false,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    pid: 0,
} as unknown as ReturnType<typeof Bun.spawnSync>;

function argvOf(first: unknown): string[] {
    if (Array.isArray(first)) {
        return first.map(String);
    }

    if (first && typeof first === "object" && "cmd" in first && Array.isArray(first.cmd)) {
        return first.cmd.map(String);
    }

    return [];
}

function isGit(argv: string[]): boolean {
    const program = argv[0] ?? "";
    return program === "git" || program.endsWith("/git");
}

export function answerGitWithoutSpawning(): GitWithoutSpawns {
    const state = { answered: 0, started: [] as string[][] };
    let restore: (() => void) | undefined;

    beforeAll(() => {
        const real = Bun.spawnSync;
        const spy = spyOn(Bun, "spawnSync").mockImplementation(((first: unknown, options?: unknown) => {
            const argv = argvOf(first);

            if (isGit(argv)) {
                state.answered++;
                return NOT_A_REPOSITORY;
            }

            state.started.push(argv);
            return Reflect.apply(real, Bun, options === undefined ? [first] : [first, options]);
        }) as typeof Bun.spawnSync);
        restore = () => spy.mockRestore();
    });

    afterAll(() => restore?.());

    return state;
}
