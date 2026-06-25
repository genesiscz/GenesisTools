import { logger } from "@app/logger";
import { env } from "@app/utils/env";
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
     * Full command line of the foreground process (e.g. `ccc --resume <id>`),
     * resolved via the pane's PID → child process → `ps -o args=`.
     */
    launchCommand: string | undefined;
    /**
     * Last prompt-style line parsed from scrollback. For interactive programs
     * (Claude Code, vim) this is often user input, not a shell command.
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
    "#{pane_pid}",
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
            panePidRaw,
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

        const panePid = Number.parseInt(panePidRaw ?? "0", 10) || 0;
        const launchCommand = panePid ? resolveLaunchCommand(panePid) : undefined;

        window.panes.push({
            index: Number.parseInt(paneIndexRaw ?? "0", 10) || 0,
            cwd: paneCwd?.trim() ? paneCwd : undefined,
            currentCommand: paneCmd?.trim() ? paneCmd : undefined,
            launchCommand,
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
 * Replace an absolute binary path with just its basename when it lives in
 * a standard bin directory (e.g. `/Users/x/.bun/bin/claude` → `claude`).
 */
function shortenCommand(args: string): string {
    return args.replace(/^\/\S+\/bin\/(\S+)/, (_match, bin: string) => bin);
}

/**
 * Given the pane's shell PID, find the first non-shell child and return its
 * full command line (e.g. `ccc --resume abc123`). Returns undefined when the
 * shell has no child (idle prompt) or the lookup fails.
 */
function resolveLaunchCommand(shellPid: number): string | undefined {
    const result = spawnImpl(["ps", "-o", "pid=,ppid=,args=", "-ax"]);
    if (result.exitCode !== 0) {
        return undefined;
    }

    const children = new Map<number, { pid: number; args: string }[]>();
    for (const line of result.stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!m) {
            continue;
        }

        const pid = Number.parseInt(m[1]!, 10);
        const ppid = Number.parseInt(m[2]!, 10);
        const args = m[3]!.trim();
        const list = children.get(ppid);
        if (list) {
            list.push({ pid, args });
        } else {
            children.set(ppid, [{ pid, args }]);
        }
    }

    const SHELLS = new Set(["zsh", "bash", "fish", "sh", "login"]);

    let current = shellPid;
    for (let depth = 0; depth < 10; depth += 1) {
        const kids = children.get(current);
        if (!kids || kids.length === 0) {
            return undefined;
        }

        const child = kids[0]!;
        const bin = child.args.split("/").pop()?.split(" ")[0] ?? "";
        if (!SHELLS.has(bin)) {
            return shortenCommand(child.args);
        }

        current = child.pid;
    }

    return undefined;
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
            const parts = [candidate];
            for (let j = i + 1; j < lines.length && parts.length < 5; j += 1) {
                const cont = lines[j]?.trimEnd();
                if (!cont || extractPromptCommand(cont) || isOutputLine(cont)) {
                    break;
                }

                parts.push(cont);
            }

            return parts.join("\n");
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

const OUTPUT_MARKERS = /^\s*[⎿✅❌⏵─│┌└├]+|^\s{6,}/;
function isOutputLine(line: string): boolean {
    return OUTPUT_MARKERS.test(line);
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

function runTmux(tmuxBin: string, args: string[], op: string): string {
    const result = spawnImpl([tmuxBin, ...args]);
    if (result.exitCode !== 0) {
        throw new Error(`tmux ${op} failed (exit ${result.exitCode}): ${result.stderr || "(no stderr)"}`);
    }
    return result.stdout;
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

    createTmuxSession(targetName, firstCwd, env.paths.getShell("/bin/zsh"));

    if (firstWindow?.name) {
        runTmux(tmuxBin, ["rename-window", "-t", `${targetName}:0`, firstWindow.name], "rename-window");
    }

    if (firstPane && !opts.skipReplay) {
        replayPane(tmuxBin, `${targetName}:0.0`, firstPane);
    }

    for (let pi = 1; pi < (firstWindow?.panes.length ?? 0); pi += 1) {
        const pane = firstWindow?.panes[pi];
        if (!pane) {
            continue;
        }

        runTmux(tmuxBin, ["split-window", "-t", `${targetName}:0`, "-c", pane.cwd ?? firstCwd], "split-window");

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

        runTmux(tmuxBin, newWindowArgs, "new-window");

        if (firstWindowPane && !opts.skipReplay) {
            replayPane(tmuxBin, `${targetName}:${wi}.0`, firstWindowPane);
        }

        for (let pi = 1; pi < window.panes.length; pi += 1) {
            const pane = window.panes[pi];
            if (!pane) {
                continue;
            }

            runTmux(tmuxBin, ["split-window", "-t", `${targetName}:${wi}`, "-c", pane.cwd ?? cwd], "split-window");

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
    const cmd = pane.lastShellCommand;
    if (!cmd) {
        return;
    }

    runTmux(tmuxBin, ["send-keys", "-t", target, cmd], "send-keys");
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
