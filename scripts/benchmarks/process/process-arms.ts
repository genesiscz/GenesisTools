/**
 * The process-table jobs `process-child.ts` can run and the arms of each, kept apart from the child so that
 * importing the list never runs a sample. The first arm of every job is the spawn the shipped code used before
 * (and still uses as its fallback), the second is the libproc / libSystem read that replaced it.
 */
export const PROCESS_ARMS = {
    /** The working directory of the caller's pids (`batchCwd`): `lsof -a -d cwd` against `proc_pidinfo`. */
    cwd: ["lsof", "libproc"],
} as const satisfies Record<string, readonly string[]>;

export type ProcessJob = keyof typeof PROCESS_ARMS;

/** How many of this user's pids the `cwd` job asks about: about what `tools port` passes for its listeners. */
export const CWD_PIDS = 30;
