import type { TitledSession } from "@genesiscz/utils/ai/transcripts/session-title";
import type { CmuxTreeView } from "@genesiscz/utils/cmux/live-layout";
import {
    liveAgentSurfaces as joinLiveAgentSurfaces,
    type LiveAgentSurface,
    newestPerLiveSurface,
    type ResolvedEntry,
    type TmuxPaneSurface,
    ttyName,
} from "@genesiscz/utils/cmux/live-surfaces";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import type { TmuxClientInfo, TmuxPaneInfo } from "@genesiscz/utils/tmux/sessions";
import { isSessionAgentId, type SessionAgentId } from "./session-agents";
import type { AdoptedSession } from "./session-close";
import { commandRunsAgent } from "./tab-process";
import { titleMatchKeys } from "./title-match";

export {
    joinTmuxPanes,
    type LiveAgentSurface,
    matchLiveAgentSurfaces,
    type TmuxPaneSurface,
} from "@genesiscz/utils/cmux/live-surfaces";

/** The live-surface join (`@genesiscz/utils/cmux/live-surfaces`), with each harness's tab-title keys. */
export function liveAgentSurfaces(input: {
    refs: Iterable<SessionCmuxRefs>;
    tree: CmuxTreeView;
    tmux?: ReadonlyMap<string, TmuxPaneSurface>;
    providerOf: (entry: SessionCmuxRefs) => string | undefined;
    agentOnTty?: (tty: string) => SessionAgentId | undefined;
    titles?: (query: string, provider: SessionAgentId) => TitledSession[];
}): LiveAgentSurface[] {
    return joinLiveAgentSurfaces({ ...input, titleKeys: titleMatchKeys });
}

/**
 * The live agent session a query names, from the cmux-refs journal joined with the live tree.
 *
 * The query is a session id (or a prefix of 8+ characters), a surface ref, or a workspace ref. Only the
 * newest session per surface counts (a surface that ran several sessions holds the last one), only
 * surfaces cmux still lists under the same surface UUID count, and the caller's own surface never does. A workspace ref adopts only
 * when exactly one agent session lives in it. `providerOf` names the agent; an entry it cannot name is
 * skipped rather than guessed, because `/exit` typed into the wrong agent is not harmless.
 */
export function pickAdoptable(input: {
    query: string;
    refs: Iterable<SessionCmuxRefs>;
    tree: CmuxTreeView;
    tmux?: ReadonlyMap<string, TmuxPaneSurface>;
    providerOf: (entry: SessionCmuxRefs) => string | undefined;
}): AdoptedSession | null {
    const needle = input.query.trim().toLowerCase();
    const hits = [...newestPerLiveSurface(input).values()].filter(({ entry, live }) => {
        const id = entry.sessionId.toLowerCase();
        return (
            id === needle ||
            (needle.length >= 8 && id.startsWith(needle)) ||
            live.ref === input.query ||
            live.workspace === input.query
        );
    });

    if (hits.length !== 1) {
        return null;
    }

    const agent = input.providerOf(hits[0].entry);

    if (!agent || !isSessionAgentId(agent)) {
        return null;
    }

    return adoptedFrom(hits[0], agent);
}

function adoptedFrom({ entry, live, tmux }: ResolvedEntry, agent: SessionAgentId): AdoptedSession {
    return {
        type: "created",
        name: entry.sessionId,
        sessionId: entry.sessionId,
        agent,
        account: "",
        model: null,
        cwd: entry.cwd ?? "",
        window: live.window,
        workspace: live.workspace,
        surface: live.ref,
        workspaceId: live.workspaceId,
        surfaceId: live.id,
        // A tmux-joined session quits through tmux and runs on the pane's tty, not on the surface's.
        tmuxSession: tmux?.session ?? null,
        // The exit command targets this pane, never the session's current one: the user may switch panes.
        tmuxPane: tmux?.pane ?? null,
        tmuxSessionCreatedMs: tmux?.sessionCreatedMs ?? null,
        pidFile: "",
        command: "",
        createdAt: new Date(entry.at).toISOString(),
        createdBy: "adopted",
        tty: tmux ? tmux.paneTty : live.tty,
    };
}

/** What a bounded process query returned (session-close-live.ts `runBounded`). */
export interface ProcessQuery {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

/**
 * Is the agent still running among the processes on its tty? Only processes of user `uid` count: root's `login` holds
 * nearly every terminal and the kernel withholds its command line, and an agent never runs as another user. One of
 * this user's processes whose command line cannot be read is unknown, so it counts as running.
 */
export function ttyProcessesShowAgent(
    entries: Array<{ uid: number | null; command: string | null; zombie: boolean }>,
    agent: SessionAgentId,
    uid: number
): boolean {
    const own = entries.filter((entry) => entry.uid === uid && !entry.zombie);

    if (own.some((entry) => entry.command === null)) {
        return true;
    }

    return ttyRunsAgent(own.map((entry) => entry.command).join("\n"), agent);
}

/** Do these command lines, one per line, show the agent? Its binary, or the `tools <agent>` launcher. */
export function ttyRunsAgent(psArgs: string, agent: SessionAgentId): boolean {
    return psArgs.split("\n").some((line) => commandRunsAgent(line.trim(), agent));
}

/**
 * Does the surface still display the agent's tmux pane? Its tmux client must still show the pane's session, and
 * the pane must still be the session's visible pane on the same tty. The user may switch tmux windows or panes
 * at any time, and keystrokes into the surface go to whatever pane it shows then.
 */
export function tmuxPaneStillShown(input: {
    joined: TmuxPaneSurface;
    surfaceTty: string | null;
    panes: readonly TmuxPaneInfo[];
    clients: readonly TmuxClientInfo[];
}): { ok: true } | { ok: false; reason: string } {
    const { joined } = input;
    const surfaceTty = ttyName(input.surfaceTty);
    const client = input.clients.find((entry) => surfaceTty !== null && ttyName(entry.tty) === surfaceTty);

    if (!client || client.session !== joined.session) {
        return { ok: false, reason: `the surface no longer shows the tmux session ${joined.session}` };
    }

    const pane = input.panes.find((entry) => entry.pane === joined.pane);

    if (!pane || pane.session !== joined.session || ttyName(pane.tty) !== joined.paneTty) {
        return { ok: false, reason: `tmux pane ${joined.pane} is no longer the agent's pane in ${joined.session}` };
    }

    if (!pane.visible) {
        return {
            ok: false,
            reason: `tmux shows another pane of ${joined.session} now, not the agent's ${joined.pane}`,
        };
    }

    return { ok: true };
}
