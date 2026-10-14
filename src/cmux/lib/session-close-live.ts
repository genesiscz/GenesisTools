import { existsSync, readFileSync } from "node:fs";
import { loadPins } from "@genesiscz/utils/agent-sessions/pins";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { findSessionsByTitle } from "@genesiscz/utils/ai/transcripts/session-title";
import { readTurnState } from "@genesiscz/utils/ai/transcripts/turn-state";
import { runCmux, runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { loadAllSessionCmuxRefs, resolveRefsProvider, type SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { argvWithChildDeadline } from "@genesiscz/utils/process/child-deadline";
import { childPids, listProcesses, processesOnTty } from "@genesiscz/utils/process/processes";
import { capture } from "@genesiscz/utils/process/ps";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { isShellProgram } from "@genesiscz/utils/shell/programs";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import { killTmuxSessionExact, listTmuxClients, listTmuxPanes } from "@genesiscz/utils/tmux/sessions";
import {
    type CmuxTreeView,
    joinTmuxPanes,
    type LiveAgentSurface,
    liveAgentSurfaces,
    type ProcessQuery,
    parseCmuxTree,
    pickAdoptable,
    type TmuxPaneSurface,
    tmuxPaneStillShown,
    ttyProcessesShowAgent,
    ttyRunsAgent,
} from "./session-adopt";
import { SESSION_AGENT_IDS, type SessionAgentId } from "./session-agents";
import {
    type AdoptedSession,
    type CloseSubject,
    isAdopted,
    type ListedWorkspace,
    readTurnLookup,
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
export async function adoptedAgentRunning(
    record: Pick<CloseSubject, "agent"> & { tty: string | null }
): Promise<boolean> {
    if (!record.tty) {
        return true;
    }
    const entries = processesOnTty(record.tty);
    // An empty terminal only means "quit" when the process table can be read at all; the whole table is read only then.
    if (entries.length === 0 && listProcesses({ commands: false }).length === 0) {
        return true;
    }
    return ttyProcessesShowAgent(entries, record.agent, process.getuid?.() ?? -1);
}

export function shellHasChildren(pid: number): boolean {
    // No children only means "no agent" when the process table can be read at all; checked only in that case.
    return childPids(pid).length > 0 || listProcesses({ commands: false }).length === 0;
}

function readPid(record: SessionCreatedRecord): number | null {
    if (!existsSync(record.pidFile)) {
        return null;
    }

    const pid = Number(readFileSync(record.pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The pid file holds the workspace shell (`printf '%s' $$`); a recycled pid running something else is gone. */
function isAlive(pid: number): boolean {
    const identity = classifyPid(pid, (command) => isShellProgram(command, { orLogin: true }));

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

/** Every terminal surface of every cmux window, with its UUID and tty. Reads in the background; it never changes focus. */
export async function liveTree(): Promise<CmuxTreeView> {
    // The surface UUIDs let adoption tell a session's own surface from a renumbered ref.
    const result = await runCmux(["--id-format", "both", "tree", "--all"], { json: true });

    if (result.code !== 0) {
        throw new Error(`cmux tree failed (${result.code}): ${result.stderr.trim()}`);
    }

    return parseCmuxTree(result.stdout);
}

/** The child dies at this deadline even if this process is killed first (child-deadline.ts). */
const CHILD_DEADLINE_MS = 8_000;
/** The parent stops waiting a little later, in case the watchdog itself is stuck. */
const CHILD_WAIT_MS = 10_000;

/** One bounded child (ps, pgrep, tmux): a wedged tmux server must not hang `agents close`. */
async function runBounded(argv: string[]): Promise<ProcessQuery> {
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

/**
 * Right before keystrokes go into a --via-tmux session's surface: does it still display the agent's pane? A
 * session that is not tmux-joined needs no check. tmux not answering is a refusal, never a yes.
 */
export async function tmuxPaneStillShownNow(
    target: LiveAgentSurface
): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!target.tmux) {
        return { ok: true };
    }

    const [panes, clients] = await Promise.all([listTmuxPanes(target.tmux.session), listTmuxClients()]);

    if (!panes.ok || !clients.ok) {
        return { ok: false, reason: panes.ok ? (clients.ok ? "" : clients.reason) : panes.reason };
    }

    return tmuxPaneStillShown({
        joined: target.tmux,
        surfaceTty: target.surface.tty,
        panes: panes.items,
        clients: clients.items,
    });
}

/** Every live agent session in cmux with its tab and workspace titles (newest per surface, caller excluded). */
/** The agents (`claude`, `codex`, `grok`) this user runs on one tty now. */
export function agentsOnTtyNow(tty: string): Set<SessionAgentId> {
    const own = processesOnTty(tty).filter(
        (entry) => entry.uid === globalThis.process.getuid?.() && !entry.zombie && entry.command
    );
    return new Set(SESSION_AGENT_IDS.filter((agent) => own.some((entry) => ttyRunsAgent(entry.command ?? "", agent))));
}

export async function liveAgentSurfacesNow(): Promise<LiveAgentSurface[]> {
    const tree = await liveTree();
    const pins = await loadPins({ readOnly: true });
    const agents = new Map<string, Set<SessionAgentId>>();
    for (const process of listProcesses()) {
        if (!process.tty || !process.command || process.zombie || process.uid !== globalThis.process.getuid?.()) {
            continue;
        }

        for (const agent of SESSION_AGENT_IDS) {
            if (ttyRunsAgent(process.command, agent)) {
                const tty = process.tty.replace(/^\/dev\//, "");
                const found = agents.get(tty) ?? new Set<SessionAgentId>();
                found.add(agent);
                agents.set(tty, found);
            }
        }
    }

    return liveAgentSurfaces({
        refs: loadAllSessionCmuxRefs().values(),
        tree,
        tmux: await liveTmuxJoin(tree),
        providerOf: (entry) => resolveRefsProvider(entry, pins.get(entry.sessionId)),
        agentOnTty: (tty) => {
            const found = agents.get(tty.replace(/^\/dev\//, ""));
            return found?.size === 1 ? [...found][0] : undefined;
        },
        titles: (query, provider) => findSessionsByTitle(query, { provider }),
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
            const listIn = async (target: string | null): Promise<ListedWorkspace[]> => {
                const result = await runCmux(["workspace", "list", ...(target ? ["--window", target] : [])], {
                    json: true,
                });

                if (result.code !== 0) {
                    throw new Error(`cmux workspace list failed (${result.code}): ${result.stderr.trim()}`);
                }

                return parseWorkspaces(result.stdout).map((workspace) => ({
                    ...workspace,
                    ...(target ? { windowId: target } : {}),
                }));
            };

            if (window) {
                return listIn(window);
            }

            // Every window: a workspace is found by its UUID wherever a relaunch put it.
            const windows = await runCmuxJSON<Array<{ id?: string }>>(["list-windows"]);
            const ids = windows.map((entry) => entry.id).filter((id): id is string => Boolean(id));
            return (await Promise.all(ids.map((id) => listIn(id)))).flat();
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
        async otherAgentOnTty(subject) {
            if (!subject.tty) {
                return null;
            }

            const entries = processesOnTty(subject.tty);
            const uid = process.getuid?.() ?? -1;
            return (
                SESSION_AGENT_IDS.find(
                    (agent) => agent !== subject.agent && ttyProcessesShowAgent(entries, agent, uid)
                ) ?? null
            );
        },
        async surfaceId(surface) {
            const surfaces = (await liveTree()).surfaces;
            const wanted = surface.toLowerCase();
            const byUuid = [...surfaces.values()].find((live) => live.id?.toLowerCase() === wanted);
            return byUuid?.id ?? surfaces.get(surface)?.id ?? null;
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
                    return { kind: "unreadable", sessionId: null, detail: panes.reason };
                }

                // The recorded agent pane only: another agent the user started in a second pane is not this one.
                // A record from before panes were stored matches any pane of its session.
                tmuxPanes = panes.items
                    .map((pane) => pane.pane)
                    .filter((pane) => !record.tmuxPane || pane === record.tmuxPane);
            }

            const sessionId = isAdopted(record)
                ? record.sessionId
                : recordedSessionIdOf({ record, refs: loadAllSessionCmuxRefs().values(), tmuxPanes });

            if (!sessionId) {
                return null;
            }

            const lookup = await readTurnLookup({
                sessionId,
                agent: record.agent,
                transcriptOf: (id, agent) => resolveTranscript(id, {}, agent),
                stateOf: (agent, filePath) => readTurnState(agent, filePath, { stallTimeoutMs: CLOSE_STALL_MS }),
            });

            if (lookup.kind === "unreadable") {
                log.debug(
                    { sessionId, detail: lookup.detail },
                    "the turn state of the session in this surface is unreadable"
                );
            }

            return lookup;
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

            const running = shellHasChildren(pid);

            return running;
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
