import { logger } from "@app/logger";
import { resolveTmuxBin } from "@app/utils/tmux/bin";
import {
    createTmuxSession,
    killTmuxSession,
    sessionExists,
    setTmuxSpawnSyncForTests,
    type TmuxSpawnSync,
} from "@app/utils/tmux/sessions";

export const SNAPSHOT_VERSION = 1 as const;

export interface TmuxPaneSnapshot {
    index: number;
    cwd: string | undefined;
    currentCommand: string | undefined;
    /**
     * Last shell command parsed from scrollback — typically the `ccc --resume <id>`
     * or `vim x` that produced the long-running process now in this pane. We do NOT
     * auto-execute this on restore; it's pre-typed at the new prompt so the user
     * can confirm with Enter.
     */
    lastShellCommand: string | undefined;
}

export interface TmuxWindowSnapshot {
    index: number;
    name: string | undefined;
    panes: TmuxPaneSnapshot[];
}

export interface TmuxSessionSnapshot {
    name: string;
    cwd: string | undefined;
    attached: boolean;
    windows: TmuxWindowSnapshot[];
}

export interface TmuxPreset {
    version: typeof SNAPSHOT_VERSION;
    name: string;
    capturedAt: string;
    note: string | undefined;
    sessions: TmuxSessionSnapshot[];
}

const PANE_LIST_FORMAT = [
    "#{session_name}",
    "#{window_index}",
    "#{window_name}",
    "#{pane_index}",
    "#{pane_current_path}",
    "#{pane_current_command}",
    "#{session_path}",
    "#{session_attached}",
].join("\t");

const defaultSpawnSync: TmuxSpawnSync = (cmd, opts) => {
    const result = Bun.spawnSync(cmd, {
        cwd: opts?.cwd,
        stdio: ["ignore", "pipe", "pipe"],
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
};

let spawnImpl: TmuxSpawnSync = defaultSpawnSync;

/** Override spawn for tests. Also forwards to sessions.ts so create/kill mock too. */
export function setTmuxSnapshotSpawnForTests(impl: TmuxSpawnSync | null): void {
    spawnImpl = impl ?? defaultSpawnSync;
    setTmuxSpawnSyncForTests(impl);
}

export interface CaptureOptions {
    /** Glob-ish prefix match. Captures only sessions whose name starts with this. */
    prefix?: string;
    /** Skip last-command parsing (faster, smaller snapshot). */
    skipHistory?: boolean;
}

export function captureTmuxSnapshot(opts: CaptureOptions = {}): TmuxSessionSnapshot[] {
    let tmuxBin: string;

    try {
        tmuxBin = resolveTmuxBin();
    } catch (error) {
        logger.debug({ error }, "captureTmuxSnapshot: tmux binary not resolvable");
        return [];
    }

    const result = spawnImpl([tmuxBin, "list-panes", "-a", "-F", PANE_LIST_FORMAT]);

    if (result.exitCode !== 0) {
        logger.debug({ exitCode: result.exitCode, stderr: result.stderr }, "captureTmuxSnapshot: list-panes failed");
        return [];
    }

    const sessionMap = new Map<string, TmuxSessionSnapshot>();
    const windowMap = new Map<string, TmuxWindowSnapshot>();

    for (const line of result.stdout.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        const [
            sessionName,
            windowIndexRaw,
            windowName,
            paneIndexRaw,
            paneCwd,
            paneCmd,
            sessionPath,
            sessionAttachedRaw,
        ] = line.split("\t");

        if (!sessionName) {
            continue;
        }

        if (opts.prefix && !sessionName.startsWith(opts.prefix)) {
            continue;
        }

        let session = sessionMap.get(sessionName);
        if (!session) {
            session = {
                name: sessionName,
                cwd: sessionPath?.trim() ? sessionPath : undefined,
                attached: Number.parseInt(sessionAttachedRaw ?? "0", 10) > 0,
                windows: [],
            };
            sessionMap.set(sessionName, session);
        }

        const windowIndex = Number.parseInt(windowIndexRaw ?? "0", 10) || 0;
        const windowKey = `${sessionName}\t${windowIndex}`;
        let window = windowMap.get(windowKey);
        if (!window) {
            window = {
                index: windowIndex,
                name: windowName?.trim() ? windowName : undefined,
                panes: [],
            };
            windowMap.set(windowKey, window);
            session.windows.push(window);
        }

        const lastShellCommand = opts.skipHistory
            ? undefined
            : parseLastShellCommand(tmuxBin, sessionName, windowIndex, paneIndexRaw ?? "0");

        window.panes.push({
            index: Number.parseInt(paneIndexRaw ?? "0", 10) || 0,
            cwd: paneCwd?.trim() ? paneCwd : undefined,
            currentCommand: paneCmd?.trim() ? paneCmd : undefined,
            lastShellCommand,
        });
    }

    for (const session of sessionMap.values()) {
        session.windows.sort((a, b) => a.index - b.index);
        for (const window of session.windows) {
            window.panes.sort((a, b) => a.index - b.index);
        }
    }

    return Array.from(sessionMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Walk the pane's scrollback bottom-up looking for the last `$ <cmd>` style prompt.
 * Best-effort — when nothing parses, returns undefined so restore falls back to just
 * `cd <cwd>`. Skip for cmd `tmux` / `claude` / `zsh` etc. would be premature here;
 * the parser already returns nothing when it can't find a recognizable prompt line.
 */
function parseLastShellCommand(
    tmuxBin: string,
    sessionName: string,
    windowIndex: number,
    paneIndex: string
): string | undefined {
    const target = `${sessionName}:${windowIndex}.${paneIndex}`;
    const result = spawnImpl([tmuxBin, "capture-pane", "-p", "-S", "-200", "-t", target]);

    if (result.exitCode !== 0) {
        return undefined;
    }

    const lines = result.stdout.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const candidate = extractPromptCommand(lines[i] ?? "");
        if (candidate) {
            return candidate;
        }
    }

    return undefined;
}

const PROMPT_LINE = /^[^\s$#%❯➜]*[$#%❯➜]\s+(.+?)\s*$/;

function extractPromptCommand(line: string): string | undefined {
    const match = PROMPT_LINE.exec(line);
    if (!match) {
        return undefined;
    }

    const cmd = match[1]?.trim();
    if (!cmd) {
        return undefined;
    }

    // Skip obvious prompt artifacts like git branch indicators, returned exit codes.
    if (cmd.length < 2 || cmd.startsWith("(")) {
        return undefined;
    }

    return cmd;
}

export interface RestoreOptions {
    /** Skip pre-typing the last shell command into the new pane. */
    skipReplay?: boolean;
    /** Rename clash: when target session already exists, suffix with this. */
    nameSuffix?: string;
}

export interface RestoreOutcome {
    name: string;
    sessionName: string;
    created: boolean;
    skipped: boolean;
    reason?: string;
}

export function restoreTmuxSession(snapshot: TmuxSessionSnapshot, opts: RestoreOptions = {}): RestoreOutcome {
    const tmuxBin = resolveTmuxBin();
    const targetName = resolveTargetName(snapshot.name, opts.nameSuffix);

    if (sessionExists(targetName)) {
        return {
            name: snapshot.name,
            sessionName: targetName,
            created: false,
            skipped: true,
            reason: "session already exists",
        };
    }

    const firstWindow = snapshot.windows[0];
    const firstPane = firstWindow?.panes[0];
    const firstCwd = firstPane?.cwd ?? snapshot.cwd ?? process.cwd();

    createTmuxSession(targetName, firstCwd, process.env.SHELL ?? "/bin/zsh");

    if (firstWindow?.name) {
        spawnImpl([tmuxBin, "rename-window", "-t", `${targetName}:0`, firstWindow.name]);
    }

    if (firstPane && !opts.skipReplay) {
        replayPane(tmuxBin, `${targetName}:0.0`, firstPane);
    }

    for (let pi = 1; pi < (firstWindow?.panes.length ?? 0); pi += 1) {
        const pane = firstWindow?.panes[pi];
        if (!pane) {
            continue;
        }

        spawnImpl([tmuxBin, "split-window", "-t", `${targetName}:0`, "-c", pane.cwd ?? firstCwd]);

        if (!opts.skipReplay) {
            replayPane(tmuxBin, `${targetName}:0.${pi}`, pane);
        }
    }

    for (let wi = 1; wi < snapshot.windows.length; wi += 1) {
        const window = snapshot.windows[wi];
        if (!window) {
            continue;
        }

        const firstWindowPane = window.panes[0];
        const cwd = firstWindowPane?.cwd ?? snapshot.cwd ?? process.cwd();

        const newWindowArgs = ["new-window", "-t", `${targetName}:`, "-c", cwd];
        if (window.name) {
            newWindowArgs.push("-n", window.name);
        }

        spawnImpl([tmuxBin, ...newWindowArgs]);

        if (firstWindowPane && !opts.skipReplay) {
            replayPane(tmuxBin, `${targetName}:${wi}.0`, firstWindowPane);
        }

        for (let pi = 1; pi < window.panes.length; pi += 1) {
            const pane = window.panes[pi];
            if (!pane) {
                continue;
            }

            spawnImpl([tmuxBin, "split-window", "-t", `${targetName}:${wi}`, "-c", pane.cwd ?? cwd]);

            if (!opts.skipReplay) {
                replayPane(tmuxBin, `${targetName}:${wi}.${pi}`, pane);
            }
        }
    }

    return {
        name: snapshot.name,
        sessionName: targetName,
        created: true,
        skipped: false,
    };
}

function replayPane(tmuxBin: string, target: string, pane: TmuxPaneSnapshot): void {
    // Send the command WITHOUT Enter — user confirms with one Return so a stale
    // resume id can't blast off automatically.
    const cmd = pane.lastShellCommand;
    if (!cmd) {
        return;
    }

    spawnImpl([tmuxBin, "send-keys", "-t", target, cmd]);
}

function resolveTargetName(baseName: string, suffix?: string): string {
    if (!suffix) {
        return baseName;
    }

    return `${baseName}${suffix}`;
}

/**
 * Kill all sessions matching `prefix`. Returns the names of sessions actually
 * killed. Idempotent — names that no longer exist are silently skipped.
 */
export function killTmuxSessionsMatching(names: string[]): string[] {
    const killed: string[] = [];

    for (const name of names) {
        if (!sessionExists(name)) {
            continue;
        }

        try {
            killTmuxSession(name);
            killed.push(name);
        } catch (error) {
            logger.warn({ error, name }, "killTmuxSessionsMatching: failed to kill session");
        }
    }

    return killed;
}
