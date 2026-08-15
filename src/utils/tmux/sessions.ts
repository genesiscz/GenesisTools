import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { buildTerminalSpawnEnv } from "@genesiscz/utils/terminal/locale";
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

function resolveLoginShell(shell: string): string {
    const trimmed = shell.trim();

    if (trimmed.length > 0 && !trimmed.includes("=")) {
        return trimmed;
    }

    const fromEnv = env.paths.getShell()?.trim();

    if (fromEnv && fromEnv.length > 0 && !fromEnv.includes("=")) {
        return fromEnv;
    }

    return "/bin/zsh";
}

/** Initial pane: `env KEY=val … /bin/zsh` so tmux never treats `truecolor` as the command. */
function tmuxLoginShellArgv(shell: string): string[] {
    const env = buildTerminalSpawnEnv();
    const argv: string[] = ["/usr/bin/env"];

    for (const key of TMUX_SESSION_ENV_KEYS) {
        const value = env[key];

        if (value) {
            argv.push(`${key}=${value}`);
        }
    }

    argv.push(resolveLoginShell(shell));

    return argv;
}

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

const defaultSpawn: TmuxSpawnSync = async (cmd, opts) => {
    // Bound every tmux call. A wedged tmux server makes `list-sessions` (and friends) block
    // forever, spinning a core at ~100% CPU; if the parent process is then killed mid-call the
    // child is orphaned and keeps spinning. 10s is far above any healthy tmux command, so this
    // only ever fires on a genuine wedge. SIGKILL because a spinning `list-sessions` ignores TERM.
    const proc = Bun.spawn(cmd, {
        cwd: opts?.cwd,
        env: buildTmuxSpawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        killSignal: "SIGKILL",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { exitCode, stdout, stderr };
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

export function setTmuxSpawnSyncForTests(impl: TmuxSpawnSync | null): void {
    spawnImpl = impl ?? defaultSpawn;
    // The server-persist TTL latch must not leak across tests that swap impls.
    lastServerPersistAt = 0;
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
export async function listTmuxSessionActivePanes(): Promise<Map<string, TmuxActivePaneInfo>> {
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

export async function createTmuxSession(sessionName: string, cwd: string, command: string): Promise<void> {
    const tmuxBin = resolveTmuxBin();
    const result = await runTmux(
        [tmuxBin, "new-session", "-d", "-s", sessionName, "-c", cwd, "--", ...tmuxLoginShellArgv(command)],
        { cwd }
    );

    if (result.exitCode !== 0) {
        throw new Error(`Failed to create tmux session ${sessionName}${tmuxErrorDetail(result.stderr)}`);
    }

    // Both best-effort and independent — run concurrently.
    await Promise.all([
        ensureTmuxSessionEnvironment(sessionName),
        // Pin the (possibly freshly-bootstrapped) server to keep sessions alive.
        ensureTmuxServerPersists(tmuxBin),
    ]);
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
    const result = await runTmux([
        bin,
        ...chainTmuxCommands([
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
