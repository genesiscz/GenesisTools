import { resolveTmuxBin } from "@app/utils/tmux/bin";
import type { TmuxSessionInfo } from "@app/utils/tmux/types";

export type TmuxSpawnSync = (cmd: string[], opts?: { cwd?: string }) => { exitCode: number | null; stdout: string };

const defaultSpawnSync: TmuxSpawnSync = (cmd, opts) => {
    const result = Bun.spawnSync(cmd, {
        cwd: opts?.cwd,
        stdio: ["ignore", "pipe", "ignore"],
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
};

let spawnSyncImpl: TmuxSpawnSync = defaultSpawnSync;

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

    const result = spawnSyncImpl([tmuxBin, "list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_windows}"]);

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
    const result = spawnSyncImpl([tmuxBin, "new-session", "-d", "-s", sessionName, "-c", cwd, command], { cwd });

    if (result.exitCode !== 0) {
        throw new Error(`Failed to create tmux session ${sessionName}`);
    }
}

export function killTmuxSession(sessionName: string): void {
    const tmuxBin = resolveTmuxBin();
    spawnSyncImpl([tmuxBin, "kill-session", "-t", sessionName]);
}
