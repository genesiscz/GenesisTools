import { errnoNow, libSystem } from "@genesiscz/utils/fs/native/libsystem";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("terminal");

/** `<sys/signal.h>` on macOS. */
const SIGTTOU = 22;
const SIG_IGN = 1;
const SIG_ERR = 0xffff_ffff_ffff_ffffn;

export type ForegroundState =
    /** The caller's group already held the terminal. */
    | { status: "kept" }
    /** The terminal belonged to group `from`, and now belongs to the caller's group again. */
    | { status: "reclaimed"; from: number }
    /** `fd` is not the caller's terminal, or this platform has no binding (only macOS has one). */
    | { status: "unavailable"; reason: string }
    | { status: "failed"; errno: number };

/**
 * Gives the terminal on `fd` back to the caller's process group.
 *
 * A child that runs an interactive shell with job control moves the terminal to a group of its own. `tools claude run`
 * starts Claude Code as `zsh -ic "exec ccc …"` so that a shell function such as `ccc` resolves: zsh forks claude into a
 * new group, gives that group the terminal, takes it for its own group when claude quits, and exits without handing it
 * back. The launcher is then a background job of its own terminal, and its next terminal call (raw mode for a prompt,
 * the mode reset at exit) stops it with SIGTTOU, which the shell shows as "suspended (tty output)" (2026-11-25).
 *
 * POSIX lets a background group take the terminal with `tcsetpgrp` only while it ignores SIGTTOU, so the handler is
 * set to SIG_IGN for that one call and put back right after.
 */
export function reclaimTerminalForeground(fd = 0): ForegroundState {
    const calls = libSystem();

    if (!calls) {
        return { status: "unavailable", reason: `no terminal binding on ${process.platform}` };
    }

    const own = calls.getpgrp();
    const holder = calls.tcgetpgrp(fd);

    if (holder < 0) {
        return { status: "unavailable", reason: `fd ${fd} is not this process's terminal (errno ${errnoNow(calls)})` };
    }

    if (holder === own) {
        return { status: "kept" };
    }

    const previous = calls.signal(SIGTTOU, SIG_IGN);

    if (BigInt(previous) === SIG_ERR) {
        const errno = errnoNow(calls);
        log.warn({ fd, holder, own, errno }, "could not ignore SIGTTOU, so the terminal was not taken back");
        return { status: "failed", errno };
    }

    let result: number;
    let errno = 0;

    try {
        result = calls.tcsetpgrp(fd, own);

        if (result !== 0) {
            errno = errnoNow(calls);
        }
    } finally {
        calls.signal(SIGTTOU, previous);
    }

    if (result !== 0) {
        log.warn({ fd, holder, own, errno }, "tcsetpgrp failed, so the terminal still belongs to another group");
        return { status: "failed", errno };
    }

    log.info({ fd, from: holder, to: own }, "took the terminal back from a group that a child left holding it");
    return { status: "reclaimed", from: holder };
}
