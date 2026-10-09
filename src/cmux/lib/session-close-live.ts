import { existsSync, readFileSync } from "node:fs";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { readTurnState } from "@genesiscz/utils/ai/transcripts/turn-state";
import { runCmux, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { loadAllSessionCmuxRefs, resolveRefsProvider, type SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import { type LiveAgentSurface, liveAgentSurfaces, parseCmuxTree, pickAdoptable, ttyRunsAgent } from "./session-adopt";
import {
    type AdoptedSession,
    type CloseSubject,
    isAdopted,
    type ListedWorkspace,
    recordedSessionIdOf,
    type SessionCloseIO,
    surfaceTarget,
} from "./session-close";
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

/** An adopted surface has no pid file: the agent runs while a process on the surface's tty is the agent. */
async function adoptedAgentRunning(record: CloseSubject & { tty: string | null }): Promise<boolean> {
    // No tty means no way to see the agent quit: assume it runs, so close never kills it without --force.
    if (!record.tty) {
        log.debug({ surface: record.surface }, "adopted surface has no tty; treating the agent as running");
        return true;
    }

    const ps = await spawnOk(["ps", "-t", record.tty, "-o", "args="]);
    return ps.code === 0 && ttyRunsAgent(ps.stdout, record.agent);
}

function readPid(record: SessionCreatedRecord): number | null {
    if (!existsSync(record.pidFile)) {
        return null;
    }

    const pid = Number(readFileSync(record.pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

const SHELL_COMMAND = /(^|\/|-)(zsh|bash|sh|fish|login)(\s|$)/;

/** The pid file holds the workspace shell (`printf '%s' $$`); a recycled pid running something else is gone. */
function isAlive(pid: number): boolean {
    const identity = classifyPid(pid, (command) => SHELL_COMMAND.test(command));

    if (identity.status === "dead" || identity.status === "foreign") {
        log.debug({ pid, status: identity.status, command: identity.command }, "session shell is gone");
        return false;
    }

    return true;
}

/** The pane ids (`%12`) of a tmux session; empty when it is gone. */
async function tmuxPanesOf(session: string): Promise<string[]> {
    const result = await spawnOk([resolveTmuxBin(), "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}"]);

    if (result.code !== 0) {
        log.debug({ session, stderr: result.stderr.trim() }, "tmux list-panes failed (session gone?)");
        return [];
    }

    return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

async function liveTree() {
    // The surface UUIDs let adoption tell a session's own surface from a renumbered ref.
    const result = await runCmux(["--id-format", "both", "tree"], { json: true });

    if (result.code !== 0) {
        throw new Error(`cmux tree failed (${result.code}): ${result.stderr.trim()}`);
    }

    return parseCmuxTree(result.stdout);
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

/** Every live agent session in cmux with its tab and workspace titles (newest per surface, caller excluded). */
export async function liveAgentSurfacesNow(): Promise<LiveAgentSurface[]> {
    return liveAgentSurfaces({
        refs: loadAllSessionCmuxRefs().values(),
        tree: await liveTree(),
        providerOf: (entry) => resolveRefsProvider(entry, undefined),
    });
}

/** Every live agent session in cmux that `close` could adopt (newest session per surface, caller excluded). */
export async function liveAdoptableSessions(): Promise<AdoptedSession[]> {
    const tree = await liveTree();
    const refs = [...loadAllSessionCmuxRefs().values()];
    const providerOf = (entry: SessionCmuxRefs) => resolveRefsProvider(entry, undefined);
    const found: AdoptedSession[] = [];

    // Only surfaces that are live now: the journal keeps every ref it ever saw, and asking for each dead one would
    // rebuild the live map once per historical ref.
    for (const live of liveAgentSurfaces({ refs, tree, providerOf })) {
        const adopted = pickAdoptable({ query: live.surface.ref, refs, tree, providerOf });

        if (adopted) {
            found.push(adopted);
        }
    }

    return found;
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
        async adopt(query) {
            const adopted = pickAdoptable({
                query,
                refs: loadAllSessionCmuxRefs().values(),
                tree: await liveTree(),
                providerOf: (entry) => resolveRefsProvider(entry, undefined),
            });
            log.debug({ query, adopted: adopted?.sessionId ?? null, surface: adopted?.surface ?? null }, "adopt");
            return adopted;
        },
        async surfaceId(surface) {
            return (await liveTree()).surfaces.get(surface)?.id ?? null;
        },
        async closeSurface(surface, window) {
            await runCmuxOk(["close-surface", "--surface", surface, ...(window ? ["--window", window] : [])]);
        },
        callerWorkspaceId: () => env.device.getCmuxWorkspaceId(),
        async turnState(record) {
            const sessionId = isAdopted(record)
                ? record.sessionId
                : recordedSessionIdOf({
                      record,
                      refs: loadAllSessionCmuxRefs().values(),
                      tmuxPanes: record.tmuxSession ? await tmuxPanesOf(record.tmuxSession) : [],
                  });

            if (!sessionId) {
                return null;
            }

            try {
                const transcript = await resolveTranscript(sessionId, {}, record.agent);
                const snapshot = readTurnState(record.agent, transcript.filePath, { stallTimeoutMs: CLOSE_STALL_MS });
                return { sessionId, state: snapshot?.state ?? "UNKNOWN" };
            } catch (error) {
                log.debug({ error, sessionId }, "no transcript for the session in this surface");
                return { sessionId, state: "UNKNOWN" };
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

            const where = surfaceTargetArgs(surfaceTarget(record));
            await runCmuxOk(["send", ...where, "--", text]);
            await Bun.sleep(300);
            await runCmuxOk(["send-key", ...where, "enter"]);
        },
        async agentRunning(record) {
            if (isAdopted(record)) {
                return adoptedAgentRunning(record);
            }

            const pid = readPid(record);

            if (pid === null || !isAlive(pid)) {
                return false;
            }

            // pgrep exits 1 when the shell has no child: the agent has quit and the shell is at its prompt.
            const children = await spawnOk(["pgrep", "-P", String(pid)]);
            return children.code === 0 && children.stdout.trim() !== "";
        },
        async closeWorkspace(workspace, window, force) {
            await runCmuxOk([
                "workspace",
                "close",
                workspace,
                ...(window ? ["--window", window] : []),
                ...(force ? ["--force"] : []),
            ]);
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
