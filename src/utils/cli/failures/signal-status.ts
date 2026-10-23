import { constants } from "node:os";

/**
 * The status a shell reports for a process that signal `name` ended: 128 + its number on this platform (SIGSEGV is
 * 139, SIGINT 130). 128 for a name the platform does not know. Kept tiny: the `tools` wrapper imports it on every run.
 */
export function signalExitStatus(name: string): number {
    return 128 + ((constants.signals as Record<string, number | undefined>)[name] ?? 0);
}
