import { existsSync } from "node:fs";

export const CHILD_DEADLINE_WATCHDOG = "/usr/bin/perl";

/**
 * Fork + alarm watchdog. The waitpid after SIGKILL is itself alarmed (1s) so a
 * child in uninterruptible sleep cannot hang the wrapper forever.
 */
export const CHILD_DEADLINE_SCRIPT =
    'my $ms=shift @ARGV; my $sec=int(($ms+999)/1000); $sec=1 if $sec<1; my $pid=fork(); die "fork: $!\\n" unless defined $pid; if($pid==0){exec {$ARGV[0]} @ARGV; exit 127} $SIG{ALRM}=sub{kill 9,$pid; $SIG{ALRM}=sub{exit 124}; alarm 1; waitpid($pid,0); exit 124}; alarm $sec; waitpid($pid,0); my $status=$?; alarm 0; my $sig=$status&127; exit($sig?128+$sig:($status>>8));';

/** Prefix argv so a parent crash cannot leave the child spinning unbounded. */
export function argvWithChildDeadline(cmd: string[], deadlineMs: number): string[] {
    if (cmd.length === 0 || !existsSync(CHILD_DEADLINE_WATCHDOG)) {
        return cmd;
    }

    return [CHILD_DEADLINE_WATCHDOG, "-e", CHILD_DEADLINE_SCRIPT, "--", String(deadlineMs), ...cmd];
}

/** The watchdog's own exit status when it killed the child at its deadline. */
export const CHILD_DEADLINE_EXIT = 124;

/**
 * Why a run through the watchdog ended early, read off its exit status, or null for an ordinary exit.
 *
 * The watchdog turns a child killed by signal N into exit status 128 + N, and exits 124 when its own deadline
 * fired. So a caller of a wrapped command sees an ordinary-looking status, never `signal`, for both. A command
 * that itself exits 124 or above 128 reads as cut short too; a caller that must not mistake a cut-short run
 * for a finished one (an irreversible send) accepts that.
 */
export function childDeadlineTermination(status: number | null): string | null {
    if (status === CHILD_DEADLINE_EXIT) {
        return "the child deadline killed it";
    }

    if (status !== null && status > 128 && status <= 128 + 64) {
        return `it was killed by signal ${status - 128}`;
    }

    return null;
}
