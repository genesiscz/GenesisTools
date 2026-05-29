import { logger } from "@app/logger";
import { resolveTmuxBin } from "@app/utils/tmux/bin";
import { buildTmuxSpawnEnv } from "@app/utils/tmux/sessions";

/**
 * Snapshot ttyd + tmux state for restart diagnostics, logged at dev-dashboard
 * startup. Two consecutive instances' snapshots reveal exactly what a `ui
 * restart` did to the sessions:
 *   - if `tmuxServerPid` changes (or sessions vanish) across a restart, the tmux
 *     server died/self-exited — taking its sessions with it;
 *   - if it's stable, the sessions survived (merely detached).
 * `exitEmpty` is the smoking gun: a server with `exit-empty on` self-destructs
 * the instant it reaches zero sessions, so a dashboard-bootstrapped server with
 * that flag will wipe every session at once. Read-only; never throws.
 */
export function logTtydTmuxSnapshot(phase: string): void {
    try {
        const tmuxBin = resolveTmuxBin();
        const env = buildTmuxSpawnEnv();

        const tmux = (args: string[]): string => {
            const result = Bun.spawnSync([tmuxBin, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
            return result.stdout.toString().trim();
        };

        const serverPid = tmux(["display-message", "-p", "#{pid}"]);
        const exitEmpty = tmux(["show-options", "-s", "exit-empty"]);
        const sessionsRaw = tmux([
            "list-sessions",
            "-F",
            "#{session_name} attached=#{session_attached} windows=#{session_windows}",
        ]);
        const sessions = sessionsRaw ? sessionsRaw.split("\n") : [];

        const ttydProcs = Bun.spawnSync(["/bin/ps", "-axo", "pid,ppid,pgid,command"], {
            stdio: ["ignore", "pipe", "ignore"],
        })
            .stdout.toString()
            .split("\n")
            .filter((line) => line.includes("ttyd -i 127"))
            .map((line) => line.trim());

        logger.info(
            {
                phase,
                tmuxServerPid: serverPid || null,
                exitEmpty: exitEmpty || null,
                sessionCount: sessions.length,
                sessions,
                ttydProcs,
            },
            "dev-dashboard ttyd/tmux snapshot"
        );
    } catch (error) {
        logger.debug({ error, phase }, "logTtydTmuxSnapshot failed");
    }
}
