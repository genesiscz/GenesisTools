import { existsSync, readFileSync } from "node:fs";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { readTurnState } from "@genesiscz/utils/ai/transcripts/turn-state";
import { runCmux, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { loadAllSessionCmuxRefs, resolveRefsProvider, type SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { argvWithChildDeadline } from "@genesiscz/utils/process/child-deadline";
import { capture } from "@genesiscz/utils/process/ps";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import { killTmuxSessionExact, listTmuxClients, listTmuxPanes } from "@genesiscz/utils/tmux/sessions";
import {
    type CmuxTreeView,
    joinTmuxPanes,
    type LiveAgentSurface,
    liveAgentSurfaces,
    parseCmuxTree,
    pickAdoptable,
    type TmuxPaneSurface,
    ttyRunsAgent,
} from "./session-adopt";
import {
    type AdoptedSession,
    type CloseSubject,
    isAdopted,
    type ListedWorkspace,
    recordedSessionIdOf,
    type SessionCloseIO,
    surfaceTarget,
    tmuxExitTarget,
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

    const ps = await runBounded(["ps", "-t", record.tty, "-o", "args="]);

    // An unanswered ps cannot show the agent quit: count it as running, like a missing tty.
    if (ps.timedOut) {
        return true;
    }

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

/**
 * Which cmux surface shows each tmux pane, for discovery (messaging, list, adoption). The listings are bounded;
 * when tmux does not answer, no tmux-only session is found, which is the safe side for a read-only lookup.
 */
async function liveTmuxJoin(tree: CmuxTreeView): Promise<Map<string, TmuxPaneSurface>> {
    const [panes, clients] = await Promise.all([listTmuxPanes(), listTmuxClients()]);

    if (!panes.ok || !clients.ok) {
        log.debug(
            { panes: panes.ok ? null : panes.reason, clients: clients.ok ? null : clients.reason },
            "tmux did not answer; --via-tmux sessions are not discoverable this time"
        );
        return new Map();
    }

    return joinTmuxPanes({ panes: panes.items, clients: clients.items, tree });
}

async function liveTree() {
    // The surface UUIDs let adoption tell a session's own surface from a renumbered ref.
    const result = await runCmux(["--id-format", "both", "tree"], { json: true });

    if (result.code !== 0) {
        throw new Error(`cmux tree failed (${result.code}): ${result.stderr.trim()}`);
    }

    return parseCmuxTree(result.stdout);
}

/** The child dies at this deadline even if this process is killed first (child-deadline.ts). */
const CHILD_DEADLINE_MS = 8_000;
/** The parent stops waiting a little later, in case the watchdog itself is stuck. */
const CHILD_WAIT_MS = 10_000;

interface Ran {
    code: number | null;
    stdout: string;
    stderr: string;
    /** Killed at the deadline: the answer is unknown, never "no". */
    timedOut: boolean;
}

/** One bounded child (ps, pgrep, tmux): a wedged tmux server must not hang `agents close`. */
async function runBounded(argv: string[]): Promise<Ran> {
    const [command, ...args] = argvWithChildDeadline(argv, CHILD_DEADLINE_MS);

    if (!command) {
        return { code: 127, stdout: "", stderr: "empty argv", timedOut: false };
    }

    const result = await capture(command, args, { timeoutMs: CHILD_WAIT_MS });
    // 124 is the watchdog's exit on its deadline; null is the parent's timeout.
    const timedOut = result.status === null || result.status === 124;

    if (timedOut) {
        log.warn({ argv }, "a child of agents close timed out; its answer is unknown");
    }

    return { code: result.status, stdout: result.stdout, stderr: result.stderr, timedOut };
}

/** Every live agent session in cmux with its tab and workspace titles (newest per surface, caller excluded). */
export async function liveAgentSurfacesNow(): Promise<LiveAgentSurface[]> {
    const tree = await liveTree();
    return liveAgentSurfaces({
        refs: loadAllSessionCmuxRefs().values(),
        tree,
        tmux: await liveTmuxJoin(tree),
        providerOf: (entry) => resolveRefsProvider(entry, undefined),
    });
}

/** Every live agent session in cmux that `close` could adopt (newest session per surface, caller excluded). */
export async function liveAdoptableSessions(): Promise<AdoptedSession[]> {
    const tree = await liveTree();
    const tmux = await liveTmuxJoin(tree);
    const refs = [...loadAllSessionCmuxRefs().values()];
    const providerOf = (entry: SessionCmuxRefs) => resolveRefsProvider(entry, undefined);
    const found: AdoptedSession[] = [];

    // Only surfaces that are live now: the journal keeps every ref it ever saw, and asking for each dead one would
    // rebuild the live map once per historical ref.
    for (const live of liveAgentSurfaces({ refs, tree, tmux, providerOf })) {
        const adopted = pickAdoptable({ query: live.surface.ref, refs, tree, tmux, providerOf });

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
            const tree = await liveTree();
            const adopted = pickAdoptable({
                query,
                refs: loadAllSessionCmuxRefs().values(),
                tree,
                tmux: await liveTmuxJoin(tree),
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
            let tmuxPanes: string[] = [];

            if (!isAdopted(record) && record.tmuxSession) {
                const panes = await listTmuxPanes(record.tmuxSession);

                if (!panes.ok) {
                    return { sessionId: null, state: "UNREADABLE", detail: panes.reason };
                }

                tmuxPanes = panes.items.map((pane) => pane.pane);
            }

            const sessionId = isAdopted(record)
                ? record.sessionId
                : recordedSessionIdOf({ record, refs: loadAllSessionCmuxRefs().values(), tmuxPanes });

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
                // The agent's own pane (checked right before this), never whichever pane the session shows now.
                const target = tmuxExitTarget(record) ?? `=${record.tmuxSession}:`;
                for (const keys of [["-l", "--", text], ["Enter"]]) {
                    const sent = await runBounded([tmux, "send-keys", "-t", target, ...keys]);

                    if (sent.code !== 0) {
                        throw new Error(
                            `tmux send-keys to ${record.tmuxSession} ${sent.timedOut ? "timed out" : `failed (${sent.code}): ${sent.stderr.trim()}`}`
                        );
                    }

                    if (keys[0] === "-l") {
                        await Bun.sleep(300);
                    }
                }
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
            const children = await runBounded(["pgrep", "-P", String(pid)]);

            // An unanswered pgrep cannot show the agent quit.
            if (children.timedOut) {
                return true;
            }

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
        killTmux: (session) => killTmuxSessionExact(session),
        tmuxPanes: (session) => listTmuxPanes(session),
        sleep: (ms) => Bun.sleep(ms),
        now: () => Date.now(),
    };
}
