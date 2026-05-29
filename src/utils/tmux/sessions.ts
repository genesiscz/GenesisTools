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
