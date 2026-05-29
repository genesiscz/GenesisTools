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

function tmuxLocaleArgs(): string[] {
    const env = buildTerminalSpawnEnv();
    const args: string[] = [];

    for (const key of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
        const value = env[key];

        if (value) {
            args.push("-e", `${key}=${value}`);
        }
    }

    return args;
}

export function ensureTmuxSessionUtf8Locale(sessionName: string): void {
    const tmuxBin = resolveTmuxBin();
    const env = buildTerminalSpawnEnv();

    for (const key of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
        const value = env[key];

        if (!value) {
            continue;
        }

        const result = spawnSyncImpl([tmuxBin, "set-environment", "-t", sessionName, key, value]);

        if (result.exitCode !== 0) {
            logger.debug(
                { sessionName, key, exitCode: result.exitCode, detail: tmuxErrorDetail(result.stderr) },
                "tmux set-environment failed (locale not applied)"
            );
        }
    }
}

const defaultSpawnSync: TmuxSpawnSync = (cmd, opts) => {
    const result = Bun.spawnSync(cmd, {
        cwd: opts?.cwd,
        env: buildTmuxSpawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
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

export function sessionExists(sessionName: string): boolean {
    return listTmuxSessions().some((session) => session.name === sessionName);
}

export function createTmuxSession(sessionName: string, cwd: string, command: string): void {
    const tmuxBin = resolveTmuxBin();
    const result = spawnSyncImpl(
        [tmuxBin, "new-session", "-d", "-s", sessionName, "-c", cwd, ...tmuxLocaleArgs(), command],
        { cwd }
    );

    if (result.exitCode !== 0) {
        throw new Error(`Failed to create tmux session ${sessionName}${tmuxErrorDetail(result.stderr)}`);
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
