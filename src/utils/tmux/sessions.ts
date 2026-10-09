import { homedir } from "node:os";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { argvWithChildDeadline as wrapArgvWithChildDeadline } from "@genesiscz/utils/process/child-deadline";
import { capture } from "@genesiscz/utils/process/ps";
import { profiler } from "@genesiscz/utils/profile";
import { buildTerminalSpawnEnv, stripTestSandboxEnv } from "@genesiscz/utils/terminal/locale";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import type { TmuxSessionInfo } from "@genesiscz/utils/tmux/types";

export interface TmuxSpawnResult {
    exitCode: number | null;
    stdout: string;
    stderr?: string;
}

/**
 * Injection seam for tests. Sync-returning impls remain valid (the core awaits
 * whatever comes back), so existing test doubles don't need to change.
 */
export type TmuxSpawnSync = (cmd: string[], opts?: { cwd?: string }) => TmuxSpawnResult | Promise<TmuxSpawnResult>;

export function buildTmuxSpawnEnv(): NodeJS.ProcessEnv {
    return buildTerminalSpawnEnv();
}

const TMUX_SESSION_ENV_KEYS = [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "COLORTERM",
    "CLAUDE_CODE_TMUX_TRUECOLOR",
    "FORCE_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
] as const;

/** The user's login shell: `$SHELL`, else `/bin/zsh`. */
function resolveLoginShell(): string {
    const fromEnv = env.paths.getShell()?.trim();

    if (fromEnv && fromEnv.length > 0 && !fromEnv.includes("=")) {
        return fromEnv;
    }

    return "/bin/zsh";
}

/** One word naming a program (`/bin/zsh`, `top`): exec'd as is. Anything with a space,
 *  a quote, `;`, `=` or other shell syntax is a command line for the login shell. */
function isBareExecutable(command: string): boolean {
    return /^[A-Za-z0-9_./+@%:,-]+$/.test(command);
}

/**
 * The first pane's argv, always `env KEY=val … <program>` so tmux never treats `truecolor` as
 * the command. A bare executable (the shell path dev-dashboard ttyd and snapshot restore pass)
 * is the program itself. A command line runs as `<login shell> -lic <line>`: tmux does no shell
 * parsing after `--`, so passing the line as one argv word made `env` look for a program named
 * `echo hi; sleep 300` and the pane died at once. `-i` loads `.zshrc`, where aliases live.
 */
export function tmuxPaneArgv(
    command: string,
    opts: { unsetEnv?: readonly string[] } = {}
): { argv: string[]; commandLine: boolean } {
    const env = buildTerminalSpawnEnv();
    // `env -u` drops a variable the tmux server's global environment would hand the pane (a caller's identity).
    const argv: string[] = ["/usr/bin/env", ...(opts.unsetEnv ?? []).flatMap((key) => ["-u", key])];

    for (const key of TMUX_SESSION_ENV_KEYS) {
        const value = env[key];

        if (value) {
            argv.push(`${key}=${value}`);
        }
    }

    const trimmed = command.trim();
    if (trimmed.length === 0) {
        return { argv: [...argv, resolveLoginShell()], commandLine: false };
    }

    if (isBareExecutable(trimmed)) {
        return { argv: [...argv, trimmed], commandLine: false };
    }

    // The tmux client splits its argv at any word that ENDS in `;`, eating that `;`. Dropping it
    // broke `find … -exec … \;`, so the word gets a trailing space instead: the shell ignores it.
    const line = trimmed.endsWith(";") ? `${trimmed} ` : trimmed;

    return { argv: [...argv, resolveLoginShell(), "-lic", line], commandLine: true };
}

/** How long a command-line session is watched for an immediate death before it counts as started. */
export const TMUX_COMMAND_SETTLE_MS = 1_000;
const TMUX_COMMAND_POLL_MS = 250;

/**
 * Join several tmux commands into ONE client invocation using tmux's `;`
 * argv separator. This is the difference between N subprocess round-trips and
 * one: the 17 idempotent set-environment/set-option calls that used to run on
 * every spawn each cost a full fork/exec/socket round-trip. On error tmux
 * aborts the remainder of the chain and exits non-zero, so chains are only
 * used for best-effort batches, never for a must-succeed command.
 */
function chainTmuxCommands(commands: string[][]): string[] {
    const argv: string[] = [];

    for (const command of commands) {
        if (argv.length > 0) {
            argv.push(";");
        }

        argv.push(...command);
    }

    return argv;
}

// Every tmux call funnels through this async spawn. The previous implementation
// used Bun.spawnSync, which blocks the WHOLE Bun event loop for the subprocess
// lifetime — in the dev-dashboard server that froze every other in-flight HTTP
// request too (a 7s spawn made an unrelated 200ms poll take 6.7s). The timing
// scope survives:
//   PROFILE=tmux tools dev-dashboard …
const prof = profiler.scope("tmux");

/**
 * Bound every tmux call. A wedged tmux server makes `list-sessions` (and friends) block
 * forever, spinning a core at ~100% CPU; if the parent process is then killed mid-call the
 * child is orphaned and keeps spinning. 10s is far above any healthy tmux command, so this
 * only ever fires on a genuine wedge. SIGKILL because a spinning `list-sessions` ignores TERM.
 *
 * Exported so every module that spawns tmux uses the SAME guard — snapshot.ts grew its own
 * spawn when capture went async and silently lost this, which put an unbounded subprocess
 * back on the dashboard's request path.
 */
export const TMUX_SPAWN_GUARD = { timeout: 10_000, killSignal: "SIGKILL" } as const;

/**
 * Deadline that lives IN the child tree. `TMUX_SPAWN_GUARD.timeout` is a Bun timer in
 * the parent; if the parent is SIGKILL'd (dashboard restart, worktree agent death) the
 * timer dies and a wedged `tmux list-sessions` is orphaned spinning at ~100% CPU.
 * Perl stays alive as PPID-1 and SIGKILLs the real client. Shorter than the Bun
 * timeout so the client is gone before Bun SIGKILLs Perl (which cannot reap on SIGKILL).
 */
export const TMUX_CHILD_DEADLINE_MS = 8_000;

/** Prefix argv so a parent crash cannot leave a spinning tmux client. */
export function argvWithChildDeadline(cmd: string[]): string[] {
    return wrapArgvWithChildDeadline(cmd, TMUX_CHILD_DEADLINE_MS);
}

const defaultSpawn: TmuxSpawnSync = async (cmd, opts) => {
    const [binary, ...args] = argvWithChildDeadline(cmd);

    if (!binary) {
        return { exitCode: 127, stdout: "", stderr: "empty argv" };
    }

    const result = await capture(binary, args, {
        timeoutMs: TMUX_SPAWN_GUARD.timeout,
        cwd: opts?.cwd,
        env: buildTmuxSpawnEnv(),
    });

    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
};

let spawnImpl: TmuxSpawnSync = defaultSpawn;

async function runTmux(cmd: string[], opts?: { cwd?: string }): Promise<TmuxSpawnResult> {
    const end = prof.start(cmd[1] ?? "tmux");

    try {
        return await spawnImpl(cmd, opts);
    } finally {
        end();
    }
}

function tmuxErrorDetail(stderr?: string): string {
    const trimmed = stderr?.trim();
    return trimmed ? `: ${trimmed}` : "";
}

/**
 * The folder a `new-session` client runs in. When no server is running, that client STARTS the
 * shared server, and the server keeps the client's folder for its whole life. On tmux 3.7c a
 * server whose folder was later deleted starts every new pane there and ignores `-c`: measured
 * 2026-09-26, a server bootstrapped from a since-removed agent worktree left every new
 * dev-dashboard terminal in "getcwd: cannot access parent directories", and `tools` died with
 * `uv_cwd ENOENT`. The home folder never disappears; `-c` still sets each pane's own folder.
 */
export function tmuxServerBootstrapCwd(): string {
    return homedir();
}

export function setTmuxSpawnSyncForTests(impl: TmuxSpawnSync | null): void {
    spawnImpl = impl ?? defaultSpawn;
    // The server-persist TTL latch must not leak across tests that swap impls.
    lastServerPersistAt = 0;
    inflightActivePanes = null;
}

export async function ensureTmuxSessionEnvironment(sessionName: string): Promise<void> {
    const tmuxBin = resolveTmuxBin();
    const env = buildTerminalSpawnEnv();
    const commands: string[][] = [];

    for (const key of TMUX_SESSION_ENV_KEYS) {
        const value = env[key];

        if (value) {
            commands.push(["set-environment", "-t", sessionName, key, value]);
        }
    }

    if (commands.length === 0) {
        return;
    }

    const result = await runTmux([tmuxBin, ...chainTmuxCommands(commands)]);

    if (result.exitCode !== 0) {
        logger.debug(
            { sessionName, exitCode: result.exitCode, detail: tmuxErrorDetail(result.stderr) },
            "tmux set-environment batch failed (session env not applied)"
        );
    }
}

/** @deprecated Use {@link ensureTmuxSessionEnvironment} */
export const ensureTmuxSessionUtf8Locale = ensureTmuxSessionEnvironment;

export async function listTmuxSessions(): Promise<TmuxSessionInfo[]> {
    let tmuxBin: string;

    try {
        tmuxBin = resolveTmuxBin();
    } catch {
        return [];
    }

    // Every extra field here is a format column on the SAME call, not another round-trip, so the
    // richer payload is free. `pane_title` is last because it is the only field that can itself
    // contain arbitrary user text.
    const result = await runTmux([
        tmuxBin,
        "list-sessions",
        "-F",
        formatWithRecordSeparator([
            "#{session_name}",
            "#{session_attached}",
            "#{session_windows}",
            "#{pane_current_command}",
            "#{pane_current_path}",
            "#{session_created}",
            "#{session_activity}",
            "#{pane_title}",
        ]),
    ]);

    if (result.exitCode !== 0) {
        return [];
    }

    const sessions: TmuxSessionInfo[] = [];

    for (const record of splitTmuxRecords(result.stdout)) {
        const [name, attachedRaw, windowsRaw, command, cwd, createdRaw, activityRaw, ...titleParts] =
            splitTmuxFields(record);
        if (!name) {
            continue;
        }

        const created = Number.parseInt(createdRaw ?? "", 10);
        const lastActivity = Number.parseInt(activityRaw ?? "", 10);

        sessions.push({
            name,
            attached: Number.parseInt(attachedRaw ?? "0", 10) || 0,
            windows: Number.parseInt(windowsRaw ?? "0", 10) || 0,
            command: command?.trim() || undefined,
            cwd: cwd?.trim() || undefined,
            title: flattenPaneTitle(titleParts.join(TMUX_FIELD_SEP)),
            created: Number.isFinite(created) ? created : undefined,
            lastActivity: Number.isFinite(lastActivity) ? lastActivity : undefined,
        });
    }

    return sessions;
}

/**
 * One `list-sessions` call mapping each session name → the command running in its active pane
 * (`#{pane_current_command}`). Lightweight (no scrollback parse, unlike `captureTmuxSnapshot`) so it
 * is cheap enough for the ttyd-list hit path that derives an auto-name from the live command.
 */
export async function listTmuxSessionCommands(): Promise<Map<string, string>> {
    const commands = new Map<string, string>();

    for (const [name, pane] of await listTmuxSessionActivePanes()) {
        if (pane.command) {
            commands.set(name, pane.command);
        }
    }

    return commands;
}

export interface TmuxActivePaneInfo {
    command: string;
    title: string;
}

/**
 * Active-pane command + title per session. Title is how Claude Code surfaces `/rename`
 * (`✳ name` / `⠐ name`) into tmux without renaming the session itself.
 *
 * The keys are the full live session-name set, so callers that only need
 * existence checks against many names should reuse this ONE call instead of
 * issuing per-name `sessionExists` list-sessions storms.
 */
let inflightActivePanes: Promise<Map<string, TmuxActivePaneInfo>> | null = null;

export async function listTmuxSessionActivePanes(): Promise<Map<string, TmuxActivePaneInfo>> {
    if (inflightActivePanes) {
        return inflightActivePanes;
    }

    inflightActivePanes = listTmuxSessionActivePanesUncoalesced().finally(() => {
        inflightActivePanes = null;
    });

    return inflightActivePanes;
}

async function listTmuxSessionActivePanesUncoalesced(): Promise<Map<string, TmuxActivePaneInfo>> {
    let tmuxBin: string;

    try {
        tmuxBin = resolveTmuxBin();
    } catch {
        return new Map();
    }

    const result = await runTmux([
        tmuxBin,
        "list-sessions",
        "-F",
        formatWithRecordSeparator(["#{session_name}", "#{pane_current_command}", "#{pane_title}"]),
    ]);

    if (result.exitCode !== 0) {
        return new Map();
    }

    const panes = new Map<string, TmuxActivePaneInfo>();

    for (const record of splitTmuxRecords(result.stdout)) {
        const [name, commandRaw = "", ...titleParts] = splitTmuxFields(record);

        if (!name) {
            continue;
        }

        panes.set(name, {
            command: commandRaw.trim(),
            title: flattenPaneTitle(titleParts.join(TMUX_FIELD_SEP)) ?? "",
        });
    }

    return panes;
}

export interface TmuxPaneInfo {
    pane: string;
    session: string;
    tty: string | null;
    sessionCreatedMs: number;
    /** The active pane of the session's active window: what an attached client displays. */
    visible: boolean;
    /** The session's id (`$3`): unique while the tmux server runs, unlike its name. */
    sessionId?: string;
}

export interface TmuxClientInfo {
    tty: string;
    session: string;
}

/** A tmux listing, or why tmux did not answer. A server or session that does not exist is an empty listing. */
export type TmuxListing<T> = { ok: true; items: T[] } | { ok: false; reason: string };

const TMUX_ABSENT = /no server running|can't find session|error connecting|no such file or directory/i;

/** Runs one bounded listing (child deadline plus TMUX_SPAWN_GUARD timeout) and parses its RS-framed records. */
async function tmuxListing<T>(args: string[], parse: (fields: string[]) => T | null): Promise<TmuxListing<T>> {
    let tmuxBin: string;

    try {
        tmuxBin = resolveTmuxBin();
    } catch (error) {
        logger.debug({ error }, "tmux listing: no tmux binary");
        return { ok: true, items: [] };
    }

    const result = await runTmux([tmuxBin, ...args]);

    if (result.exitCode === 0) {
        const items: T[] = [];

        for (const record of splitTmuxRecords(result.stdout)) {
            const item = parse(splitTmuxFields(record));

            if (item !== null) {
                items.push(item);
            }
        }

        return { ok: true, items };
    }

    const stderr = result.stderr?.trim() ?? "";

    if (result.exitCode !== null && TMUX_ABSENT.test(stderr)) {
        return { ok: true, items: [] };
    }

    const reason =
        result.exitCode === null
            ? `tmux ${args[0]} did not answer within ${TMUX_SPAWN_GUARD.timeout / 1000} s`
            : `tmux ${args[0]} failed (${result.exitCode})${tmuxErrorDetail(stderr)}`;
    logger.debug({ args, exitCode: result.exitCode, stderr }, "tmux listing failed");
    return { ok: false, reason };
}

/** Every pane (or the panes of one session, matched exactly) with its session, tty and whether a client shows it. */
export async function listTmuxPanes(session?: string): Promise<TmuxListing<TmuxPaneInfo>> {
    const scope = session === undefined ? ["-a"] : ["-s", "-t", `=${session}`];
    const format = formatWithRecordSeparator([
        "#{pane_id}",
        "#{session_name}",
        "#{pane_tty}",
        "#{session_created}",
        "#{window_active}",
        "#{pane_active}",
        "#{session_id}",
    ]);

    return tmuxListing(
        ["list-panes", ...scope, "-F", format],
        ([pane, name, tty, created, windowActive, paneActive, sessionId]) =>
            pane && name
                ? {
                      pane,
                      session: name,
                      tty: tty || null,
                      sessionCreatedMs: Number(created) * 1000,
                      visible: windowActive === "1" && paneActive === "1",
                      ...(sessionId ? { sessionId } : {}),
                  }
                : null
    );
}

/** Every attached client with its tty and the session it shows. */
export async function listTmuxClients(): Promise<TmuxListing<TmuxClientInfo>> {
    return tmuxListing(
        ["list-clients", "-F", formatWithRecordSeparator(["#{client_tty}", "#{session_name}"])],
        ([tty, name]) => (tty && name ? { tty, session: name } : null)
    );
}

/**
 * ASCII RS (U+001E) between records, US (U+001F) between fields.
 *
 * Two different corruptions, both from values that are arbitrary user text:
 *
 *  - `#{pane_title}` containing a NEWLINE used to terminate its own record, so the rest
 *    parsed as another session — with tabs in it, a convincing phantom one.
 *  - `#{pane_current_path}` containing a TAB shifted every field after it. Verified
 *    against tmux 3.6a: a cwd of `…/tab\tpath` yields NINE tab-separated fields, so the
 *    timestamps land one column late and the title absorbs the overflow. Putting the
 *    title last only ever protected the title.
 *
 * Neither can be escaped inside a tmux format string, so the delimiters are control
 * bytes instead — both pass through `list-sessions -F` intact, and no shell, path or
 * terminal title writes them.
 */
const TMUX_RECORD_SEP = "\x1e";
const TMUX_FIELD_SEP = "\x1f";

export function formatWithRecordSeparator(fields: string[]): string {
    return `${TMUX_RECORD_SEP}${fields.join(TMUX_FIELD_SEP)}`;
}

/** Split one RS-framed record into its fields. */
export function splitTmuxFields(record: string): string[] {
    return record.split(TMUX_FIELD_SEP);
}

/** Split RS-framed `list-sessions` output; tmux still terminates each record with a newline. */
export function splitTmuxRecords(stdout: string): string[] {
    return stdout
        .split(TMUX_RECORD_SEP)
        .map((record) => record.replace(/\n+$/, ""))
        .filter((record) => record.trim().length > 0);
}

/** Collapse a multi-line / padded pane title into the single display line callers expect. */
function flattenPaneTitle(raw: string | undefined): string | undefined {
    return raw?.replace(/\s+/g, " ").trim() || undefined;
}

export async function sessionExists(sessionName: string): Promise<boolean> {
    // Each call is a full `list-sessions`. Callers checking MANY names should reuse
    // one listTmuxSessions()/listTmuxSessionActivePanes() result instead of looping this.
    return (await listTmuxSessions()).some((session) => session.name === sessionName);
}

/**
 * Create a detached session in `cwd`. `command` is either a bare executable (usually the shell
 * path) or a command line, which runs through the login shell. A command-line session keeps its
 * pane after the command ends (`remain-on-exit`), so the output stays readable; when the command
 * dies with a non-zero status within `settleMs`, the session is killed and this throws with the
 * pane's last lines instead of reporting a session that no longer works.
 */
export async function createTmuxSession(
    sessionName: string,
    cwd: string,
    command: string,
    opts: { settleMs?: number; unsetEnv?: readonly string[] } = {}
): Promise<void> {
    const tmuxBin = resolveTmuxBin();
    const pane = tmuxPaneArgv(command, { unsetEnv: opts.unsetEnv });
    const newSession = [tmuxBin, "new-session", "-d", "-s", sessionName, "-c", cwd, "--", ...pane.argv];
    // Chained into the same client call, so the option is set before tmux can reap a command
    // that fails in its first millisecond.
    const result = await runTmux(
        pane.commandLine
            ? chainTmuxCommands([newSession, ["set-option", "-t", sessionName, "remain-on-exit", "on"]])
            : newSession,
        { cwd: tmuxServerBootstrapCwd() }
    );

    if (result.exitCode !== 0) {
        throw new Error(`Failed to create tmux session ${sessionName}${tmuxErrorDetail(result.stderr)}`);
    }

    if (pane.commandLine) {
        await failIfCommandDied(tmuxBin, sessionName, opts.settleMs ?? TMUX_COMMAND_SETTLE_MS);
    }

    // Both best-effort and independent — run concurrently.
    await Promise.all([
        ensureTmuxSessionEnvironment(sessionName),
        // Pin the (possibly freshly-bootstrapped) server to keep sessions alive.
        ensureTmuxServerPersists(tmuxBin),
    ]);
}

/** What tmux reports for a pane's death, from `#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}`. A signal
 *  death (SIGSEGV, SIGKILL) leaves the status empty and sets the signal; both are failures, as is a non-zero
 *  status. `failure` is null for a live pane and for a clean exit. */
export function parsePaneDeath(line: string): { dead: boolean; failure: string | null } {
    const [dead = "", status = "", signal = ""] = line.trim().split("|");

    if (dead !== "1") {
        return { dead: false, failure: null };
    }

    if (signal.length > 0) {
        return { dead: true, failure: `was killed by signal ${signal}` };
    }

    if (status.length > 0 && status !== "0") {
        return { dead: true, failure: `exited with status ${status}` };
    }

    return { dead: true, failure: null };
}

/** Watch a command-line pane for `settleMs`. A pane that died with a non-zero status takes its
 *  session down and throws with the last lines it printed. */
async function failIfCommandDied(tmuxBin: string, sessionName: string, settleMs: number): Promise<void> {
    const deadline = Date.now() + settleMs;

    while (true) {
        const state = await runTmux([
            tmuxBin,
            "display-message",
            "-p",
            "-t",
            sessionName,
            "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}",
        ]);
        const { dead, failure } = parsePaneDeath(state.stdout);
        if (failure !== null) {
            const captured = await runTmux([tmuxBin, "capture-pane", "-p", "-t", sessionName, "-S", "-20"]);
            await killTmuxSession(sessionName);
            // A short-lived pane is mostly empty rows; keep only the lines with text.
            const output = captured.stdout
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .join("\n");
            logger.warn({ sessionName, failure, output }, "tmux session command exited at once");
            throw new Error(
                `tmux session ${sessionName}: the command ${failure}${output.length > 0 ? `:\n${output}` : ""}`
            );
        }

        const remaining = deadline - Date.now();
        if (dead || remaining <= 0) {
            return;
        }

        await Bun.sleep(Math.min(TMUX_COMMAND_POLL_MS, remaining));
    }
}

/**
 * Detached tmux session whose first pane runs `argv` (not a login shell).
 * Used by `tools claude run --tmux` so Claude is the session process.
 */
export async function createTmuxSessionRunning(
    sessionName: string,
    cwd: string,
    argv: string[],
    extraEnv: Record<string, string | undefined> = {}
): Promise<void> {
    if (argv.length === 0) {
        throw new Error("createTmuxSessionRunning needs a command");
    }

    const envArgv = ["/usr/bin/env"];
    const merged: Record<string, string | undefined> = { ...buildTmuxSpawnEnv(), ...extraEnv };
    for (const [key, value] of Object.entries(merged)) {
        if (typeof value === "string" && value.length > 0 && !key.includes("=") && !key.includes("\n")) {
            envArgv.push(`${key}=${value}`);
        }
    }

    const tmuxBin = resolveTmuxBin();
    const result = await runTmux(
        [tmuxBin, "new-session", "-d", "-s", sessionName, "-c", cwd, "--", ...envArgv, ...argv],
        { cwd: tmuxServerBootstrapCwd() }
    );

    if (result.exitCode !== 0) {
        throw new Error(`Failed to create tmux session ${sessionName}${tmuxErrorDetail(result.stderr)}`);
    }

    await Promise.all([ensureTmuxSessionEnvironment(sessionName), ensureTmuxServerPersists(tmuxBin)]);
}

/** Live tmux session name for this process, or undefined when not attached. */
export async function currentTmuxSessionName(): Promise<string | undefined> {
    if (!env.get("TMUX")) {
        return undefined;
    }

    const tmuxBin = resolveTmuxBin();
    const result = await runTmux([tmuxBin, "display-message", "-p", "#{session_name}"]);
    const name = result.stdout.trim();
    return result.exitCode === 0 && name.length > 0 ? name : undefined;
}

/**
 * Pin the tmux server so sessions survive detach/teardown instead of dying,
 * AND scrub the server's global environment of color-killing inheritance from
 * whichever process happened to bootstrap it.
 *
 * tmux defaults to `exit-empty on`: the server process exits the instant it has
 * zero sessions, taking every remaining session with it at once. A headless
 * `new-session` (how the dashboard and cmux bootstrap the shared default server)
 * inherits that stock default — unlike an interactive tmux, where tmux-continuum
 * flips `exit-empty off`. So on the shared socket whether sessions survive a UI
 * restart otherwise depends on who bootstrapped the server first. The dashboard
 * uses tmux as a session daemon that must outlive restarts, so force the durable
 * options on every time it touches the server.
 *
 * The env scrub fixes a separate bug: tmux captures its founder process's env
 * in the SERVER GLOBAL env and seeds EVERY new session's shell with the same
 * vars — including any chalk/supports-color poison the founder happened to
 * carry (NO_COLOR=1, FORCE_COLOR=0, CLICOLOR_FORCE=0, CARGO_TERM_COLOR=never,
 * PIP_NO_COLOR=1; Claude Code subprocess paths set these to keep ANSI out of
 * captured tool output, and once tmux freezes them in its global env they
 * outlive every dashboard restart). `-gu` unsets the monochrome vars for the
 * whole server, `-g` forces the positive ones, and once a server has been
 * touched by this function its global env is colour-clean regardless of who
 * bootstrapped it. All set-options are idempotent and safe.
 *
 * All nine commands ride ONE tmux invocation, and the whole thing is skipped
 * within a short TTL: the options are server-global and idempotent, so
 * re-running them on every spawn/attach only added subprocess round-trips.
 */
const SERVER_PERSIST_TTL_MS = 60_000;
let lastServerPersistAt = 0;

/** `show-environment -g` output as a record; `-KEY` lines (explicit unsets) are skipped. */
export function parseTmuxEnvironment(stdout: string): NodeJS.ProcessEnv {
    const parsed: NodeJS.ProcessEnv = {};

    for (const line of stdout.split("\n")) {
        const eq = line.indexOf("=");

        if (eq <= 0 || line.startsWith("-")) {
            continue;
        }

        parsed[line.slice(0, eq)] = line.slice(eq + 1);
    }

    return parsed;
}

/**
 * Names the server global env still carries from a `bun test` founder. tmux
 * freezes its founder's environment and seeds every later session from it, so a
 * suite that bootstrapped the shared server hands its throwaway
 * `GENESIS_TOOLS_HOME` to dashboard terminals for as long as the server lives.
 * See {@link stripTestSandboxEnv} for the incident this comes from.
 */
function sandboxKeysIn(globalEnv: NodeJS.ProcessEnv): string[] {
    const cleaned = stripTestSandboxEnv({ ...globalEnv });
    return Object.keys(globalEnv).filter((key) => !(key in cleaned));
}

async function poisonedServerEnvKeys(bin: string): Promise<string[]> {
    const result = await runTmux([bin, "show-environment", "-g"]);

    if (result.exitCode !== 0) {
        logger.debug(
            { exitCode: result.exitCode, detail: tmuxErrorDetail(result.stderr) },
            "ensureTmuxServerPersists: show-environment failed; sandbox scrub skipped"
        );
        return [];
    }

    const keys = sandboxKeysIn(parseTmuxEnvironment(result.stdout));

    if (keys.length > 0) {
        logger.warn({ keys }, "tmux server global env carries a test sandbox; unsetting for new sessions");
    }

    return keys;
}

export async function ensureTmuxServerPersists(tmuxBin?: string): Promise<void> {
    if (Date.now() - lastServerPersistAt < SERVER_PERSIST_TTL_MS) {
        return;
    }

    let bin: string;

    try {
        bin = tmuxBin ?? resolveTmuxBin();
    } catch (error) {
        logger.debug({ error }, "ensureTmuxServerPersists: tmux binary not resolvable");
        return;
    }

    // -u = unset; -g = global. set-environment runs FIRST in the chain so any
    // session created immediately after this call gets the clean env.
    const sandboxKeys = await poisonedServerEnvKeys(bin);
    const result = await runTmux([
        bin,
        ...chainTmuxCommands([
            ...sandboxKeys.map((key) => ["set-environment", "-gu", key]),
            ["set-environment", "-gu", "NO_COLOR"],
            ["set-environment", "-gu", "CARGO_TERM_COLOR"],
            ["set-environment", "-gu", "PIP_NO_COLOR"],
            ["set-environment", "-g", "COLORTERM", "truecolor"],
            ["set-environment", "-g", "FORCE_COLOR", "1"],
            ["set-environment", "-g", "CLICOLOR", "1"],
            ["set-environment", "-g", "CLICOLOR_FORCE", "1"],
            ["set-option", "-s", "exit-empty", "off"],
            ["set-option", "-g", "destroy-unattached", "off"],
        ]),
    ]);

    if (result.exitCode !== 0) {
        logger.debug(
            { exitCode: result.exitCode, detail: tmuxErrorDetail(result.stderr) },
            "ensureTmuxServerPersists: tmux batch failed"
        );
        return;
    }

    // Only latch on success — a failure (e.g. `set-environment -gu` on a var
    // that a wedged server rejects) should be retried on the next touch.
    lastServerPersistAt = Date.now();
}

/**
 * Kill one session, matched exactly (a bare name falls back to a prefix match on another session), and say
 * whether it is gone. A session or server that does not exist counts as gone; a tmux that does not answer
 * within the shared deadline does not.
 */
export async function killTmuxSessionExact(sessionName: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    // A session id (`$3`) names one session for the server's lifetime; a name is matched exactly.
    const target = sessionName.startsWith("$") ? sessionName : `=${sessionName}`;
    const result = await runTmux([resolveTmuxBin(), "kill-session", "-t", target]);
    const stderr = result.stderr?.trim() ?? "";

    if (result.exitCode === 0 || (result.exitCode !== null && TMUX_ABSENT.test(stderr))) {
        return { ok: true };
    }

    const reason =
        result.exitCode === null
            ? `tmux kill-session did not answer within ${TMUX_SPAWN_GUARD.timeout / 1000} s`
            : `tmux kill-session failed (${result.exitCode})${tmuxErrorDetail(stderr)}`;
    logger.warn({ sessionName, exitCode: result.exitCode, stderr }, "tmux kill-session did not end the session");
    return { ok: false, reason };
}

export async function killTmuxSession(sessionName: string): Promise<void> {
    const tmuxBin = resolveTmuxBin();
    await runTmux([tmuxBin, "kill-session", "-t", sessionName]);
}

/**
 * Hand the controlling terminal to `tmux attach-session`. Replaces our stdio with
 * tmux's; control returns on detach (C-b d) or session kill. The caller MUST guard
 * for a TTY first — attaching without one fails. Throws on a non-zero exit.
 *
 * Deliberately sync: this is a CLI-only TTY handoff that blocks until the user
 * detaches — there is no event loop to protect.
 */
export function attachTmuxSession(sessionName: string): void {
    const tmuxBin = resolveTmuxBin();
    const result = Bun.spawnSync([tmuxBin, "attach-session", "-t", sessionName], {
        stdio: ["inherit", "inherit", "inherit"],
    });

    if (result.exitCode !== 0) {
        throw new Error(`tmux attach-session exited with code ${result.exitCode}`);
    }
}

export async function renameTmuxSession(fromName: string, toName: string): Promise<void> {
    const tmuxBin = resolveTmuxBin();
    const trimmed = toName.trim();

    if (!trimmed) {
        throw new Error("tmux session name cannot be empty");
    }

    // One list-sessions for both checks — `sessionExists` is a full listing per call.
    const liveNames = new Set((await listTmuxSessions()).map((session) => session.name));

    if (!liveNames.has(fromName)) {
        throw new Error(`tmux session ${fromName} does not exist`);
    }

    if (fromName !== trimmed && liveNames.has(trimmed)) {
        throw new Error(`tmux session ${trimmed} already exists`);
    }

    const result = await runTmux([tmuxBin, "rename-session", "-t", fromName, trimmed]);

    if (result.exitCode !== 0) {
        throw new Error(`Failed to rename tmux session ${fromName}${tmuxErrorDetail(result.stderr)}`);
    }
}

export interface TmuxScrollState {
    /** Lines of scrollback history above the live screen. */
    historySize: number;
    /** Visible rows of the pane. */
    paneHeight: number;
    /** Lines scrolled up from the live bottom (0 = at the bottom / following output). */
    scrollPosition: number;
    /** Whether the pane is currently in copy-mode (where scrollPosition is meaningful). */
    inMode: boolean;
    /**
     * Whether the alternate screen is active — i.e. a full-screen TUI app
     * (Claude Code, vim, less) is running. Such apps own their own scrolling and
     * consume mouse-wheel events; tmux copy-mode does NOT scroll *their* viewport,
     * so the scrollbar must send wheel events to the app instead.
     */
    alternateOn: boolean;
}

/**
 * Read scrollback geometry for a session's active pane. `scrollPosition` is only
 * reported by tmux in copy-mode, so it reads as 0 (live bottom) when `inMode` is
 * false. Returns null if tmux is unavailable or the session is gone.
 */
export async function getTmuxScrollState(sessionName: string): Promise<TmuxScrollState | null> {
    let tmuxBin: string;

    try {
        tmuxBin = resolveTmuxBin();
    } catch (error) {
        logger.debug({ error }, "getTmuxScrollState: tmux binary not resolvable");
        return null;
    }

    const result = await runTmux([
        tmuxBin,
        "display-message",
        "-p",
        "-t",
        sessionName,
        "-F",
        "#{history_size}|#{pane_height}|#{scroll_position}|#{pane_in_mode}|#{alternate_on}",
    ]);

    if (result.exitCode !== 0) {
        return null;
    }

    const [hist, height, scroll, inMode, alternate] = result.stdout.trim().split("|");

    return {
        historySize: Number.parseInt(hist ?? "0", 10) || 0,
        paneHeight: Number.parseInt(height ?? "0", 10) || 0,
        scrollPosition: scroll && scroll.length > 0 ? Number.parseInt(scroll, 10) || 0 : 0,
        inMode: inMode === "1",
        alternateOn: alternate === "1",
    };
}

/**
 * Scroll a session's active pane to `fraction` of its scrollback, where 0 is the
 * oldest line (top of history) and 1 is the live bottom. Drives tmux copy-mode:
 * a fraction at/near the bottom cancels copy-mode so the pane follows live output
 * again; otherwise it parks at the exact line via history-bottom + N scroll-up.
 */
export async function scrollTmuxToFraction(sessionName: string, fraction: number): Promise<void> {
    if (!Number.isFinite(fraction)) {
        return;
    }

    let tmuxBin: string;

    try {
        tmuxBin = resolveTmuxBin();
    } catch (error) {
        logger.debug({ error }, "scrollTmuxToFraction: tmux binary not resolvable");
        return;
    }

    const state = await getTmuxScrollState(sessionName);

    if (!state) {
        return;
    }

    const clamped = Math.min(1, Math.max(0, fraction));
    const fromBottom = Math.min(state.historySize, Math.round((1 - clamped) * state.historySize));

    if (fromBottom <= 0) {
        if (state.inMode) {
            await runTmux([tmuxBin, "send-keys", "-t", sessionName, "-X", "cancel"]);
        }

        return;
    }

    if (!state.inMode) {
        await runTmux([tmuxBin, "copy-mode", "-t", sessionName]);
    }

    // One invocation: park at the bottom of history, then step up N lines.
    await runTmux([
        tmuxBin,
        ...chainTmuxCommands([
            ["send-keys", "-t", sessionName, "-X", "history-bottom"],
            ["send-keys", "-t", sessionName, "-X", "-N", String(fromBottom), "scroll-up"],
        ]),
    ]);
}
