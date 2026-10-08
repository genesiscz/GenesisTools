import { existsSync, readFileSync } from "node:fs";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { readTurnState } from "@genesiscz/utils/ai/transcripts/turn-state";
import { runCmux, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { loadAllSessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import type { ListedWorkspace, SessionCloseIO } from "./session-close";
import type { SessionCreatedRecord, SessionStore } from "./session-store";

const { log } = logger.scoped("cmux-session");

/** The stall limit only colours STALLED vs RUNNING; close refuses RUNNING alone. */
const CLOSE_STALL_MS = 15 * 60 * 1000;

function parseWorkspaces(stdout: string): ListedWorkspace[] {
    const parsed: unknown = SafeJSON.parse(stdout, { strict: true });

    if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("workspaces" in parsed) ||
        !Array.isArray(parsed.workspaces)
    ) {
        return [];
    }

    const listed: ListedWorkspace[] = [];

    for (const entry of parsed.workspaces) {
        if (typeof entry !== "object" || entry === null) {
            continue;
        }

        const ref = "ref" in entry && typeof entry.ref === "string" ? entry.ref : null;
        const id = "id" in entry && typeof entry.id === "string" ? entry.id : null;

        if (ref && id) {
            const cwd =
                "current_directory" in entry && typeof entry.current_directory === "string"
                    ? entry.current_directory
                    : null;
            listed.push({ ref, id, cwd });
        }
    }

    return listed;
}

function readPid(record: SessionCreatedRecord): number | null {
    if (!existsSync(record.pidFile)) {
        return null;
    }

    const pid = Number(readFileSync(record.pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        log.debug({ error, pid }, "session shell is gone");
        return false;
    }
}

async function spawnOk(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { code, stdout, stderr };
}

export function liveSessionCloseIO(store: SessionStore): SessionCloseIO {
    return {
        store,
        async listWorkspaces(window) {
            const result = await runCmux(["workspace", "list", ...(window ? ["--window", window] : [])], {
                json: true,
            });

            if (result.code !== 0) {
                throw new Error(`cmux workspace list failed (${result.code}): ${result.stderr.trim()}`);
            }

            return parseWorkspaces(result.stdout);
        },
        callerWorkspaceId: () => env.device.getCmuxWorkspaceId(),
        async turnState(record) {
            const createdAt = Date.parse(record.createdAt);
            let newest: { sessionId: string; at: number } | null = null;

            for (const refs of loadAllSessionCmuxRefs().values()) {
                if (refs.surfaceRef === record.surface && refs.at >= createdAt - 60_000) {
                    if (!newest || refs.at > newest.at) {
                        newest = { sessionId: refs.sessionId, at: refs.at };
                    }
                }
            }

            if (!newest) {
                return null;
            }

            try {
                const transcript = await resolveTranscript(newest.sessionId, {}, record.agent);
                const snapshot = readTurnState(record.agent, transcript.filePath, { stallTimeoutMs: CLOSE_STALL_MS });
                return { sessionId: newest.sessionId, state: snapshot?.state ?? "UNKNOWN" };
            } catch (error) {
                log.debug({ error, sessionId: newest.sessionId }, "no transcript for the session in this surface");
                return { sessionId: newest.sessionId, state: "UNKNOWN" };
            }
        },
        async sendExit(record, text) {
            if (record.tmuxSession) {
                const tmux = resolveTmuxBin();
                await spawnOk([tmux, "send-keys", "-t", record.tmuxSession, "-l", "--", text]);
                await Bun.sleep(300);
                await spawnOk([tmux, "send-keys", "-t", record.tmuxSession, "Enter"]);
                return;
            }

            const where = surfaceTargetArgs(record.surface);
            await runCmuxOk(["send", ...where, "--", text]);
            await Bun.sleep(300);
            await runCmuxOk(["send-key", ...where, "enter"]);
        },
        async agentRunning(record) {
            const pid = readPid(record);

            if (pid === null || !isAlive(pid)) {
                return false;
            }

            // pgrep exits 1 when the shell has no child: the agent has quit and the shell is at its prompt.
            const children = await spawnOk(["pgrep", "-P", String(pid)]);
            return children.code === 0 && children.stdout.trim() !== "";
        },
        async closeWorkspace(workspace, window) {
            await runCmuxOk(["workspace", "close", workspace, ...(window ? ["--window", window] : [])]);
        },
        async killTmux(session) {
            const result = await spawnOk([resolveTmuxBin(), "kill-session", "-t", session]);

            if (result.code !== 0) {
                log.debug({ session, stderr: result.stderr.trim() }, "tmux kill-session failed (already gone?)");
            }
        },
        sleep: (ms) => Bun.sleep(ms),
        now: () => Date.now(),
    };
}
