import {
    accessSync,
    chmodSync,
    closeSync,
    constants,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    realpathSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { processStartMs } from "@genesiscz/utils/process-identity";
import { shellSingleQuote } from "./shell-quote";

/**
 * Claude Code's tmux teammate spawn only forwards a hard-coded env allowlist
 * (`LW_` in the bundle). `CLAUDE_CODE_OAUTH_TOKEN` is intentionally absent
 * (it lives in the secrets list `X_e`), so agent-team panes launched under
 * `tools cc run <account>` come up as "Not logged in".
 *
 * Escape hatch (still present in CC): `CLAUDE_CODE_TEAMMATE_COMMAND` replaces
 * the binary path used for teammate processes. We point it at a per-launch
 * mode-700 wrapper that hardcodes the lead's OAuth launch env, then execs the
 * real claude binary with the original `--agent-id …` args.
 *
 * Per-PID wrappers keep concurrent multi-account leads isolated (no shared
 * `active.env` race). See Claude/Bugs/TeammateTmuxNotRespectingOauthTokens.md.
 */

export interface TeammateAuthEnv {
    oauthToken: string;
    subscriptionType: string;
    accountName: string;
    fableModel?: string;
    customModelOption?: string;
    customModelOptionName?: string;
    customModelOptionDescription?: string;
}

export interface InstallTeammateWrapperInput {
    env: TeammateAuthEnv;
    /** Absolute path to the real `claude` binary. */
    claudeBin: string;
    /** Override dir (tests). Default: ~/.genesis-tools/claude/teammate-wrappers */
    dir?: string;
    /** Override unique id (tests). Default: `${pid}-${random}` */
    id?: string;
}

export interface InstalledTeammateWrapper {
    path: string;
}

export function teammateWrappersDir(): string {
    return join(env.paths.getHome() ?? env.tools.getHome(), ".genesis-tools", "claude", "teammate-wrappers");
}

/**
 * Where to look for `claude`, in order. Must yield a file path, not a shell
 * function (`ccc`/`claude` wrappers from rc): CC execs TEAMMATE_COMMAND directly.
 *
 * Split out and injectable because the last-resort branch below is otherwise
 * untestable from inside this repo: `Bun.which("claude")` finds our own
 * `node_modules/@anthropic-ai/claude-code` no matter what PATH says, so no test
 * could ever force every candidate to miss.
 */
export function claudeBinaryCandidates(): string[] {
    const home = env.paths.getHome() ?? homedir();

    return [
        join(home, ".bun", "bin", "claude"),
        join(home, ".local", "bin", "claude"),
        Bun.which("claude") ?? undefined,
    ].filter((p): p is string => Boolean(p));
}

export function resolveClaudeBinaryForTeammates(candidatesFor: () => string[] = claudeBinaryCandidates): string {
    const candidates = candidatesFor();

    for (const candidate of candidates) {
        try {
            if (!existsSync(candidate)) {
                continue;
            }

            accessSync(candidate, constants.X_OK);
            return realpathSync(candidate);
        } catch (error) {
            logger.debug({ error, candidate }, "[teammate-wrapper] candidate claude binary not usable; trying next");
        }
    }

    // Last resort: leave it on PATH for the wrapper's exec, because aborting the
    // LEAD launch over a teammate's binary is the worse failure.
    //
    // The one way this still works is a tmux pane whose PATH carries a `claude`
    // this process's PATH does not, which is why it is not a hard error. What it
    // can NEVER be is a shell function or alias, as the previous comment here
    // suggested: the wrapper is `#!/usr/bin/env bash` with `set -euo pipefail`,
    // sources no profile, and ends in `exec`, so only a real executable resolves.
    // Bun.which already looked, so error level rather than warn: this is a
    // probably-broken teammate, and the log is the only place that says so.
    logger.error(
        "[teammate-wrapper] no executable `claude` found (checked ~/.bun/bin, ~/.local/bin and PATH). " +
            "The wrapper will exec `claude` and the teammate will fail unless the tmux pane's PATH has one. " +
            "Install it somewhere on PATH, or point the lead at an absolute path."
    );
    return "claude";
}

export function buildTeammateWrapperScript(input: { claudeBin: string; env: TeammateAuthEnv }): string {
    const { claudeBin, env: auth } = input;
    const exports: Array<[string, string]> = [
        ["TOOLS_CLAUDE_ACCOUNT", auth.accountName],
        ["CLAUDE_CODE_OAUTH_TOKEN", auth.oauthToken],
        ["CLAUDE_CODE_SUBSCRIPTION_TYPE", auth.subscriptionType],
    ];

    if (auth.fableModel) {
        exports.push(["ANTHROPIC_DEFAULT_FABLE_MODEL", auth.fableModel]);
    }

    if (auth.customModelOption) {
        exports.push(["ANTHROPIC_CUSTOM_MODEL_OPTION", auth.customModelOption]);
    }

    if (auth.customModelOptionName) {
        exports.push(["ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", auth.customModelOptionName]);
    }

    if (auth.customModelOptionDescription) {
        exports.push(["ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", auth.customModelOptionDescription]);
    }

    const exportLines = exports.map(([k, v]) => `export ${k}=${shellSingleQuote(v)}`).join("\n");

    return `#!/usr/bin/env bash
# Generated by tools cc run — do not edit. Deleted when the lead session exits.
# Injects OAuth launch env into Claude Code agent-team tmux teammates
# (CC's spawn allowlist does not forward CLAUDE_CODE_OAUTH_TOKEN).
set -euo pipefail
${exportLines}
exec ${shellSingleQuote(claudeBin)} "$@"
`;
}

/** The wrapper holds the OAuth token in plaintext — owner-only, never group/other. */
const WRAPPER_MODE = 0o700;

/**
 * When the process started, from `ps -o etime=` ([[dd-]hh:]mm:ss). null when
 * it cannot be determined; callers must treat that as "identity unknown".
 */
export { processStartMs };

/** `<pid>-<startMs>-<rand>`: the sweep compares the recorded start EXACTLY, so a reused pid is detectable. 0 = start unknown. */
function wrapperId(): string {
    const startMs = processStartMs(process.pid) ?? 0;
    return `${process.pid}-${Math.round(startMs)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function installTeammateWrapper(input: InstallTeammateWrapperInput): InstalledTeammateWrapper {
    const dir = input.dir ?? teammateWrappersDir();

    // Tracked outside the try: once the file exists the token is on disk, so
    // EVERY later failure (chmod, stat, even the fail-closed unlink) must
    // still attempt to remove it before throwing.
    let created: string | undefined;

    try {
        mkdirSync(dir, { recursive: true, mode: WRAPPER_MODE });

        // mkdirSync's mode applies only when it CREATES the directory. A dir
        // inherited from an older build (or a looser umask) keeps its own mode,
        // so re-assert it before writing a token inside.
        chmodSync(dir, WRAPPER_MODE);

        const path = join(dir, `wrapper-${input.id ?? wrapperId()}.sh`);
        const script = buildTeammateWrapperScript({ claudeBin: input.claudeBin, env: input.env });

        // Open with "wx" (exclusive create) FIRST, mark the path created, then
        // write through the descriptor. "wx" also guarantees we never write a
        // token into a pre-existing file, whose mode open(2) would have kept.
        const fd = openSync(path, "wx", WRAPPER_MODE);
        created = path;

        try {
            writeFileSync(fd, script);
        } finally {
            closeSync(fd);
        }

        // umask can only clear permission bits, never add them, so the mode
        // above is an upper bound on any POSIX filesystem. Verify anyway and
        // fail closed: a mount that ignores creation modes must not hand out a
        // readable token.
        chmodSync(path, WRAPPER_MODE);
        const mode = statSync(path).mode & 0o777;

        if ((mode & 0o077) !== 0) {
            unlinkSync(path);
            created = undefined;
            throw new Error(
                `teammate wrapper ${path} landed with mode ${mode.toString(8)}; refusing to store the token`
            );
        }

        logger.debug(
            { path, account: input.env.accountName, claudeBin: input.claudeBin },
            "[teammate-wrapper] installed CLAUDE_CODE_TEAMMATE_COMMAND wrapper"
        );

        return { path };
    } catch (error) {
        if (created) {
            try {
                unlinkSync(created);
            } catch (cleanupError) {
                // ENOENT means it is already gone, which IS success.
                if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
                    logger.warn({ cleanupError, created }, "[teammate-wrapper] could not remove a partial wrapper");
                }
            }
        }

        throw error;
    }
}

export function removeTeammateWrapper(path: string | undefined): void {
    if (!path) {
        return;
    }

    try {
        if (existsSync(path)) {
            unlinkSync(path);
            logger.debug({ path }, "[teammate-wrapper] removed");
        }
    } catch (error) {
        logger.warn({ error, path }, "[teammate-wrapper] failed to remove wrapper");
    }
}

/** True when a process with this pid exists (signal 0 probes without killing). */
function pidAlive(pid: number): boolean {
    return isProcessAlive(pid);
}

/**
 * Two etime-derived estimates of the SAME process's start differ by ps's
 * one-second granularity plus query-time rounding, never by more.
 */
const START_IDENTITY_TOLERANCE_MS = 5_000;

/**
 * Drop leftover wrappers from sessions that are gone; each holds a token in
 * plaintext. The filename embeds the owner's identity (pid plus process start
 * time recorded at install), compared EXACTLY against the live process:
 *
 * - owner pid dead: swept immediately, whatever the wrapper's age;
 * - pid alive with a matching start time (± ps precision): the real owner,
 *   kept indefinitely, because long-running sessions still spawn teammates;
 * - pid alive with a different start time: the pid was reused by an unrelated
 *   process, so sweep;
 * - either start time unknown: identity unprovable, kept while the pid is
 *   alive but only up to maxAgeMs, which is also the fallback for filenames
 *   with no parseable identity.
 *
 * Best-effort; never throws. The old sweep was mtime-only, which deleted a
 * live 8-day session's wrapper out from under it and left dead sessions'
 * tokens on disk for a week.
 */
export function sweepStaleTeammateWrappers(
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
    dir?: string,
    startMsOf: (pid: number) => number | null = processStartMs
): number {
    const root = dir ?? teammateWrappersDir();

    if (!existsSync(root)) {
        return 0;
    }

    let removed = 0;

    try {
        const now = Date.now();

        for (const name of readdirSync(root)) {
            if (!name.startsWith("wrapper-") || !name.endsWith(".sh")) {
                continue;
            }

            const match = /^wrapper-(\d+)-(\d+)-[a-z0-9]+\.sh$/.exec(name);
            const full = join(root, name);

            try {
                const overAgeCap = now - statSync(full).mtimeMs > maxAgeMs;

                let stale: boolean;

                if (!match) {
                    // Legacy `wrapper-<pid>-<rand>.sh` names carry no start
                    // time; age is all we have.
                    stale = overAgeCap;
                } else if (!pidAlive(Number(match[1]))) {
                    stale = true;
                } else {
                    const recordedStartMs = Number(match[2]);
                    const currentStartMs = startMsOf(Number(match[1]));

                    if (recordedStartMs === 0 || currentStartMs === null) {
                        stale = overAgeCap;
                    } else {
                        stale = Math.abs(currentStartMs - recordedStartMs) > START_IDENTITY_TOLERANCE_MS;
                    }
                }

                if (stale) {
                    unlinkSync(full);
                    removed++;
                }
            } catch (error) {
                logger.debug({ error, full }, "[teammate-wrapper] could not sweep wrapper; leaving it in place");
            }
        }
    } catch (error) {
        logger.debug({ error, root }, "[teammate-wrapper] sweep failed");
    }

    return removed;
}
