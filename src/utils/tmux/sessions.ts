import { logger } from "@app/logger";
import { buildTerminalSpawnEnv } from "@app/utils/terminal/locale";
import { resolveTmuxBin } from "@app/utils/tmux/bin";
import type { TmuxSessionInfo } from "@app/utils/tmux/types";

export type TmuxSpawnSync = (
    cmd: string[],
    opts?: { cwd?: string }
) => { exitCode: number | null; stdout: string; stderr?: string };

export function buildTmuxSpawnEnv(): NodeJS.ProcessEnv {
    return buildTerminalSpawnEnv();
}

const TMUX_SESSION_ENV_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "COLORTERM", "CLAUDE_CODE_TMUX_TRUECOLOR"] as const;

function resolveLoginShell(shell: string): string {
    const trimmed = shell.trim();

    if (trimmed.length > 0 && !trimmed.includes("=")) {
        return trimmed;
    }

    const fromEnv = process.env.SHELL?.trim();

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

export function ensureTmuxSessionEnvironment(sessionName: string): void {
    const tmuxBin = resolveTmuxBin();
    const env = buildTerminalSpawnEnv();

    for (const key of TMUX_SESSION_ENV_KEYS) {
        const value = env[key];

        if (!value) {
            continue;
        }

        const result = spawnSyncImpl([tmuxBin, "set-environment", "-t", sessionName, key, value]);

        if (result.exitCode !== 0) {
            logger.debug(
                { sessionName, key, exitCode: result.exitCode, detail: tmuxErrorDetail(result.stderr) },
                "tmux set-environment failed (session env not applied)"
            );
        }
    }
}

/** @deprecated Use {@link ensureTmuxSessionEnvironment} */
export const ensureTmuxSessionUtf8Locale = ensureTmuxSessionEnvironment;

const defaultSpawnSync: TmuxSpawnSync = (cmd, opts) => {
    const result = Bun.spawnSync(cmd, {
        cwd: opts?.cwd,
        env: buildTmuxSpawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // Bound every tmux call. A wedged tmux server makes `list-sessions` (and friends) block
        // forever, spinning a core at ~100% CPU; if the parent process is then killed mid-call the
        // child is orphaned and keeps spinning. 10s is far above any healthy tmux command, so this
        // only ever fires on a genuine wedge. SIGKILL because a spinning `list-sessions` ignores TERM.
        timeout: 10_000,
        killSignal: "SIGKILL",
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
};

let spawnSyncImpl: TmuxSpawnSync = defaultSpawnSync;

function tmuxErrorDetail(stderr?: string): string {
    const trimmed = stderr?.trim();
    return trimmed ? `: ${trimmed}` : "";
}

export function setTmuxSpawnSyncForTests(impl: TmuxSpawnSync | null): void {
    spawnSyncImpl = impl ?? defaultSpawnSync;
}

export function listTmuxSessions(): TmuxSessionInfo[] {
    let tmuxBin: string;

    try {
        tmuxBin = resolveTmuxBin();
    } catch {
        return [];
    }

    const result = spawnSyncImpl([
        tmuxBin,
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_attached}\t#{session_windows}",
    ]);

    if (result.exitCode !== 0) {
        return [];
    }

    const sessions: TmuxSessionInfo[] = [];

    for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const [name, attachedRaw, windowsRaw] = trimmed.split("\t");
        if (!name) {
            continue;
        }

        sessions.push({
            name,
            attached: Number.parseInt(attachedRaw ?? "0", 10) || 0,
            windows: Number.parseInt(windowsRaw ?? "0", 10) || 0,
        });
    }

    return sessions;
}

/**
 * One `list-sessions` call mapping each session name → the command running in its active pane
 * (`#{pane_current_command}`). Lightweight (no scrollback parse, unlike `captureTmuxSnapshot`) so it
 * is cheap enough for the ttyd-list hit path that derives an auto-name from the live command.
 */
export function listTmuxSessionCommands(): Map<string, string> {
    let tmuxBin: string;

    try {
        tmuxBin = resolveTmuxBin();
    } catch {
        return new Map();
    }

    const result = spawnSyncImpl([tmuxBin, "list-sessions", "-F", "#{session_name}\t#{pane_current_command}"]);

    if (result.exitCode !== 0) {
        return new Map();
    }

    const commands = new Map<string, string>();

    for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const tab = trimmed.indexOf("\t");
        if (tab === -1) {
            continue;
        }

        const name = trimmed.slice(0, tab);
        const command = trimmed.slice(tab + 1).trim();

        if (name && command) {
            commands.set(name, command);
        }
    }

    return commands;
}

export function sessionExists(sessionName: string): boolean {
    return listTmuxSessions().some((session) => session.name === sessionName);
}

export function createTmuxSession(sessionName: string, cwd: string, command: string): void {
    const tmuxBin = resolveTmuxBin();
    const result = spawnSyncImpl(
        [tmuxBin, "new-session", "-d", "-s", sessionName, "-c", cwd, "--", ...tmuxLoginShellArgv(command)],
        { cwd }
    );

    if (result.exitCode !== 0) {
        throw new Error(`Failed to create tmux session ${sessionName}${tmuxErrorDetail(result.stderr)}`);
    }

    ensureTmuxSessionEnvironment(sessionName);

    // Pin the (possibly freshly-bootstrapped) server to keep sessions alive.
    ensureTmuxServerPersists(tmuxBin);
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
 * The env scrub fixes a separate bug: if the founder process had `NO_COLOR=1`
 * (Claude Code subprocesses commonly do) or `COLORTERM=""`, tmux captures it in
 * the SERVER GLOBAL env and seeds EVERY new session's shell with the same vars
 * — making Claude TUI render monochrome inside ttyd panes. `-gu NO_COLOR` unsets
 * it for the whole server; setting COLORTERM=truecolor on the global ensures new
 * sessions don't inherit an empty value either. All set-options are idempotent
 * and safe.
 */
export function ensureTmuxServerPersists(tmuxBin?: string): void {
    let bin: string;

    try {
        bin = tmuxBin ?? resolveTmuxBin();
    } catch (error) {
        logger.debug({ error }, "ensureTmuxServerPersists: tmux binary not resolvable");
        return;
    }

    // -u = unset; -g = global. Run set-environment FIRST so any session created
    // immediately after this call (e.g. createTmuxSession → ensureTmuxServerPersists
    // → next createTmuxSession) gets the clean env.
    const setOptionArgs: string[][] = [
        ["set-environment", "-gu", "NO_COLOR"],
        ["set-environment", "-g", "COLORTERM", "truecolor"],
        ["set-option", "-s", "exit-empty", "off"],
        ["set-option", "-g", "destroy-unattached", "off"],
    ];

    for (const args of setOptionArgs) {
        const result = spawnSyncImpl([bin, ...args]);

        if (result.exitCode !== 0) {
            logger.debug(
                { args, exitCode: result.exitCode, detail: tmuxErrorDetail(result.stderr) },
                "ensureTmuxServerPersists: tmux set-option failed"
            );
        }
    }
}

export function killTmuxSession(sessionName: string): void {
    const tmuxBin = resolveTmuxBin();
    spawnSyncImpl([tmuxBin, "kill-session", "-t", sessionName]);
}

export function renameTmuxSession(fromName: string, toName: string): void {
    const tmuxBin = resolveTmuxBin();
    const trimmed = toName.trim();

    if (!trimmed) {
        throw new Error("tmux session name cannot be empty");
    }

    if (!sessionExists(fromName)) {
        throw new Error(`tmux session ${fromName} does not exist`);
    }

    if (fromName !== trimmed && sessionExists(trimmed)) {
        throw new Error(`tmux session ${trimmed} already exists`);
    }

    const result = spawnSyncImpl([tmuxBin, "rename-session", "-t", fromName, trimmed]);

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
export function getTmuxScrollState(sessionName: string): TmuxScrollState | null {
    let tmuxBin: string;

    try {
        tmuxBin = resolveTmuxBin();
    } catch (error) {
        logger.debug({ error }, "getTmuxScrollState: tmux binary not resolvable");
        return null;
    }

    const result = spawnSyncImpl([
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
export function scrollTmuxToFraction(sessionName: string, fraction: number): void {
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

    const state = getTmuxScrollState(sessionName);

    if (!state) {
        return;
    }

    const clamped = Math.min(1, Math.max(0, fraction));
    const fromBottom = Math.min(state.historySize, Math.round((1 - clamped) * state.historySize));

    if (fromBottom <= 0) {
        if (state.inMode) {
            spawnSyncImpl([tmuxBin, "send-keys", "-t", sessionName, "-X", "cancel"]);
        }

        return;
    }

    if (!state.inMode) {
        spawnSyncImpl([tmuxBin, "copy-mode", "-t", sessionName]);
    }

    spawnSyncImpl([tmuxBin, "send-keys", "-t", sessionName, "-X", "history-bottom"]);
    spawnSyncImpl([tmuxBin, "send-keys", "-t", sessionName, "-X", "-N", String(fromBottom), "scroll-up"]);
}
