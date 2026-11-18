import { existsSync } from "node:fs";

/**
 * How macOS schedules a child process:
 * - `low`: `taskpolicy -b`, background QoS whatever the parent's QoS is. The child runs on the efficiency cores and
 *   yields to everything else, so it costs more CPU seconds and much more wall time (measured 2026-11-18: one voice
 *   pass took 251 CPU s in the background against about 91 CPU s at normal priority).
 * - `normal`: the parent's QoS. A child of a background parent (a launchd `ProcessType=Background` job) is throttled.
 * - `high`: the child clears any background state it inherited before the command starts, so it runs at normal QoS
 *   even under a background parent.
 * Without /usr/sbin/taskpolicy or /usr/bin/perl (any system but macOS) `low` and `high` run as `normal`.
 */
export const PROCESS_PRIORITIES = ["high", "normal", "low"] as const;
export type ProcessPriority = (typeof PROCESS_PRIORITIES)[number];

const PERL = "/usr/bin/perl";
const TASKPOLICY = "/usr/sbin/taskpolicy";

/**
 * Lifts the process out of darwin background (`setpriority(PRIO_DARWIN_PROCESS, 0, 0)`, PRIO_DARWIN_PROCESS = 4),
 * then execs the command. A process may clear its own background state even when it inherited it, which `taskpolicy
 * -B` cannot do for another process (measured 2026-10-12: a `taskpolicy -b` child stays at priority 4 after
 * `taskpolicy -B -p`, and reaches 31 after clearing its own).
 */
const RAISE_FROM_BACKGROUND =
    'setpriority(4, 0, 0) or warn "setpriority: $!\\n"; exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\\n"';

export interface PriorityTools {
    perl: boolean;
    taskpolicy: boolean;
}

export function priorityToolsOnDisk(): PriorityTools {
    return { perl: existsSync(PERL), taskpolicy: existsSync(TASKPOLICY) };
}

/** The argv that runs `command` through `sh -c` at `priority`. Arguments after it reach the shell as `$0`, `$1`, …. */
export function priorityShellArgv(
    command: string,
    priority: ProcessPriority,
    onDisk: PriorityTools = priorityToolsOnDisk()
): string[] {
    const shell = ["sh", "-c", command];

    if (priority === "low" && onDisk.taskpolicy) {
        return [TASKPOLICY, "-b", ...shell];
    }

    if (priority === "high" && onDisk.perl) {
        return [PERL, "-e", RAISE_FROM_BACKGROUND, ...shell];
    }

    return shell;
}
