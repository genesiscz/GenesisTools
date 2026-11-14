import { dialogRefusal } from "@genesiscz/utils/agents/dialogs/guard";
import { sessionOpenDialog } from "@genesiscz/utils/agents/dialogs/session";
import type { OpenDialog } from "@genesiscz/utils/agents/dialogs/types";
import { ACCOUNT_PROVIDER_ALIASES, type AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { CmuxRunResult } from "@genesiscz/utils/cmux/lib/cli";
import { cmuxTreeView } from "@genesiscz/utils/cmux/live-layout";
import { type LiveAgentSurface, tmuxPaneStillShown, ttyName } from "@genesiscz/utils/cmux/live-surfaces";
import { type SurfaceKeyPress, writeSurfaceInput } from "@genesiscz/utils/cmux/surface-input";
import { cmuxDidNotAnswer, type ReadCmuxTreeOptions, readCmuxTree } from "@genesiscz/utils/cmux/tree-read";
import { logger } from "@genesiscz/utils/logger";
import { runsAgent } from "@genesiscz/utils/process/classify";
import { type ProcessEntry, processesOnTty } from "@genesiscz/utils/process/processes";
import { isShellProgram } from "@genesiscz/utils/shell/programs";
import { listTmuxClients, listTmuxPanes } from "@genesiscz/utils/tmux/sessions";
import { EMPTY_TREE, type LocateOptions, liveSessionReads, locateLiveSurfaces } from "./locate";

/**
 * Typing into a running session's tab: the one guarded input. It takes a session id, finds the session's cmux surface
 * through the live-session locator, and writes only after every guard passed, in this order:
 *
 * 1. the surface's tty runs one session of this session's agent and no other agent session (a worker started inside
 *    another agent's tab inherits the tab, and the input would reach the tab's real agent; a second Claude counts);
 * 2. a --via-tmux session's surface still shows the agent's tmux pane;
 * 3. no question, plan or permission dialog is open in the session (state signals, never a screen read);
 * 4. no draft: cmux's own check on the paste refuses while a person is typing in the prompt.
 *
 * The tmux check runs again right before the write, because the dialog read takes time and the user may switch panes.
 * The text is pasted, never typed; keys are pressed after it. Who finds a session by a title or a working directory
 * (`tools claude cmux focus`, `read`) keeps its own matcher and types through `writeSurfaceInput` directly.
 */

const log = logger.child({ component: "session-input" });

export type SessionInputRefusal =
    | "not-found"
    | "tty-shared"
    | "ambiguous"
    | "tmux-hidden"
    | "dialog-open"
    | "draft-present"
    | "timeout";

export type SessionInputOutcome =
    | {
          delivered: true;
          /** The surface ref the input went to (`surface:12`). */
          surface: string;
          /** The located surface, with its verified UUID. */
          target: LiveAgentSurface & { surface: { id: string } };
      }
    | {
          delivered: false;
          reason: SessionInputRefusal;
          /** One sentence for a log or a person: what refused and why. */
          detail: string;
          /** Set when part of the input may already be in the pane (a timed-out write, or a refusal after a press). */
          mayHaveLanded?: boolean;
          /** The open dialog, for a `dialog-open` refusal from the state signals. */
          dialog?: OpenDialog;
      };

export type SessionKeyPress = SurfaceKeyPress;

export interface SessionInput {
    sessionId: string;
    /** Pasted, never typed. */
    text?: string;
    /** Pressed after the text, in order: a named key (`enter`, `escape`), or `{ text }` typed through `cmux send`. */
    keys?: readonly SessionKeyPress[];
    /** Submit the pasted text in the same call (`cmux paste --submit`). */
    submit?: boolean;
    /** The agent the session must run; without it, the agent the locator found on its surface. */
    provider?: AccountProviderAlias;
    /**
     * The open dialog or a draft does not stop the input: a dialog answer (the dialog is the target), or an explicit
     * `--force`. The tty and tmux guards still apply.
     */
    force?: boolean;
    /**
     * Only a surface the hook journal recorded for this session. A surface the locator matched to the session by a
     * unique tab title is skipped, because another session can share that topic: a caller that must not guess
     * (`--exact-session`) then gets `not-found` instead of a write.
     */
    recordedOnly?: boolean;
}

export type SurfaceLookup = { ok: true; surfaces: LiveAgentSurface[] } | { ok: false; detail: string };

/** The reads and the writer behind the guards; tests replace each, so no real cmux tree, tty or tmux pane is read. */
export interface SessionInputDeps {
    /** The live agent surfaces; `{ ok: false }` when cmux did not answer, so no tab can be ruled out. */
    surfaces?: () => Promise<SurfaceLookup>;
    /** The keys a tab title is tried by when the journal does not know the session (the cmux tool's `titleMatchKeys`). */
    titleKeys?: LocateOptions["titleKeys"];
    /** The agent sessions running on a tty now, one entry per session (`["claude", "claude"]` is two Claude sessions). */
    agentsOnTty?: (tty: string) => Iterable<string>;
    /** Does a --via-tmux session's surface still show the agent's pane? */
    stillShown?: (target: LiveAgentSurface) => Promise<{ ok: true } | { ok: false; reason: string }>;
    openDialog?: (input: { sessionId: string; provider: AccountProviderAlias }) => Promise<OpenDialog | null>;
    run?: (args: string[]) => Promise<CmuxRunResult>;
}

/**
 * The live agent surfaces now. A cmux that did not answer (timed out, backed off, or hung) is a refusal: it is then
 * unknown which tabs exist. A cmux that answered with nothing (not running) has no surfaces.
 */
export async function liveSurfacesNow(
    options: { titleKeys?: LocateOptions["titleKeys"]; tree?: ReadCmuxTreeOptions } = {}
): Promise<SurfaceLookup> {
    const read = await readCmuxTree(options.tree);

    if (!read.ok && cmuxDidNotAnswer(read)) {
        return { ok: false, detail: `cmux did not answer the tree read (${read.reason}): ${read.error}` };
    }

    const view = read.ok ? cmuxTreeView(read.tree) : EMPTY_TREE;
    const reads = { ...liveSessionReads(), tree: async () => view };
    return { ok: true, surfaces: await locateLiveSurfaces(reads, reads.processes(), options.titleKeys) };
}

/** The agent sessions (`claude`, `codex`, `grok`) this user runs on one tty now, one entry per session. */
export function agentsOnTtyNow(tty: string): AccountProviderAlias[] {
    const uid = globalThis.process.getuid?.();
    const own = processesOnTty(ttyName(tty) ?? tty).filter(
        (entry) => entry.command !== null && !entry.zombie && (uid === undefined || entry.uid === uid)
    );
    return agentSessionsOf(own);
}

/**
 * One entry per agent session among the processes of one tty. An agent process counts once with the processes that
 * start it: a wrapper (`tools claude resume`) or a launcher of the same agent (Codex's npm script and its native
 * binary) above it, through any process that is not a shell. An agent started from a shell is a session of its own,
 * even when that shell belongs to another agent: a worker started from a Claude tool shell inside another Claude
 * session's tab is the second `claude` here, and input meant for one of them could reach the other.
 */
export function agentSessionsOf(processes: readonly ProcessEntry[]): AccountProviderAlias[] {
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const agentOf = new Map<number, AccountProviderAlias>();

    for (const entry of processes) {
        const agent = ACCOUNT_PROVIDER_ALIASES.find((alias) => runsAgent(entry.command ?? "", alias));

        if (agent) {
            agentOf.set(entry.pid, agent);
        }
    }

    const startedBySameAgent = (entry: ProcessEntry, agent: AccountProviderAlias): boolean => {
        const seen = new Set<number>([entry.pid]);
        let parent = byPid.get(entry.ppid);

        while (parent && !seen.has(parent.pid)) {
            if (agentOf.get(parent.pid) === agent) {
                return true;
            }

            if (isShellProgram(parent.command ?? parent.name)) {
                return false;
            }

            seen.add(parent.pid);
            parent = byPid.get(parent.ppid);
        }

        return false;
    };

    return [...agentOf].flatMap(([pid, agent]) => {
        const entry = byPid.get(pid);

        return entry && !startedBySameAgent(entry, agent) ? [agent] : [];
    });
}

/**
 * Right before keystrokes go into a --via-tmux session's surface: does it still display the agent's pane? A session
 * that is not tmux-joined needs no check. tmux not answering is a refusal, never a yes.
 */
export async function tmuxPaneStillShownNow(
    target: LiveAgentSurface
): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!target.tmux) {
        return { ok: true };
    }

    const [panes, clients] = await Promise.all([listTmuxPanes(target.tmux.session), listTmuxClients()]);

    if (!panes.ok || !clients.ok) {
        return {
            ok: false,
            reason: `tmux did not answer: ${panes.ok ? (clients.ok ? "" : clients.reason) : panes.reason}`,
        };
    }

    return tmuxPaneStillShown({
        joined: target.tmux,
        surfaceTty: target.surface.tty,
        panes: panes.items,
        clients: clients.items,
    });
}

function refusal(
    input: SessionInput,
    reason: SessionInputRefusal,
    detail: string,
    extra: { mayHaveLanded?: boolean; dialog?: OpenDialog } = {}
): SessionInputOutcome {
    log.debug({ sessionId: input.sessionId, reason, detail }, "session input refused");
    return { delivered: false, reason, detail, ...extra };
}

/** Paste text and press keys into a running session's tab, after every guard; see the module comment. */
export async function sendToSession(input: SessionInput, deps: SessionInputDeps = {}): Promise<SessionInputOutcome> {
    if (input.text === undefined && !input.keys?.length) {
        throw new Error("sendToSession needs a text to paste or keys to press");
    }

    const lookup = await (deps.surfaces ?? (() => liveSurfacesNow({ titleKeys: deps.titleKeys })))();

    if (!lookup.ok) {
        return refusal(input, "timeout", `nothing was sent to session ${input.sessionId}: ${lookup.detail}`);
    }

    const candidates = lookup.surfaces.filter(
        (entry) =>
            entry.sessionId === input.sessionId &&
            (!input.provider || entry.agent === input.provider) &&
            !(input.recordedOnly && entry.transcriptPath)
    );

    if (candidates.length > 1) {
        return refusal(
            input,
            "ambiguous",
            `nothing was sent: ${candidates.length} surfaces name session ${input.sessionId} (${candidates
                .map((entry) => entry.surface.ref)
                .join(", ")})`
        );
    }

    const target = candidates[0];

    if (!target) {
        return refusal(input, "not-found", `session ${input.sessionId} has no live cmux surface`);
    }

    // The input names the surface UUID the locator verified against the journal: after a cmux restart a ref can name
    // another terminal.
    const surfaceId = target.surface.id;

    if (!surfaceId) {
        return refusal(
            input,
            "not-found",
            `${target.surface.ref} has no surface UUID, so the input has no safe target`
        );
    }

    const ref = target.surface.ref;
    const tty = target.tmux?.paneTty ?? target.surface.tty;
    const running: string[] = tty ? [...(deps.agentsOnTty ?? agentsOnTtyNow)(tty)] : [];
    const own = running.filter((agent) => agent === target.agent).length;

    if (own !== 1 || running.length > 1) {
        const others = [...new Set(running.filter((agent) => agent !== target.agent))];
        return refusal(
            input,
            "tty-shared",
            `nothing was sent to ${ref}: ${
                own > 1
                    ? `it runs ${own} ${target.agent} sessions, so the input could reach another one`
                    : own === 1
                      ? `it also runs ${others.join(", ")}, so the input could reach that agent`
                      : `it runs ${others.length > 0 ? others.join(", ") : "no agent"}, not ${target.agent}`
            }`
        );
    }

    const stillShown = deps.stillShown ?? tmuxPaneStillShownNow;
    const shown = await stillShown(target);

    if (!shown.ok) {
        return refusal(input, "tmux-hidden", `nothing was sent to ${ref}: ${shown.reason}`);
    }

    if (!input.force) {
        const dialog = await (deps.openDialog ?? sessionOpenDialog)({
            sessionId: input.sessionId,
            provider: target.agent,
        });

        if (dialog) {
            return refusal(input, "dialog-open", dialogRefusal(dialog), { dialog });
        }

        if (target.tmux) {
            const again = await stillShown(target);

            if (!again.ok) {
                return refusal(input, "tmux-hidden", `nothing was sent to ${ref}: ${again.reason}`);
            }
        }
    }

    const wrote = await writeSurfaceInput({
        where: ["--surface", surfaceId],
        text: input.text,
        submit: input.submit,
        keys: input.keys,
        force: input.force,
        run: deps.run,
    });

    if (!wrote.ok) {
        return refusal(input, wrote.reason, `${ref}: ${wrote.detail}`, { mayHaveLanded: wrote.mayHaveLanded });
    }

    log.debug({ sessionId: input.sessionId, surface: ref, keys: input.keys?.length ?? 0 }, "session input delivered");
    return { delivered: true, surface: ref, target: { ...target, surface: { ...target.surface, id: surfaceId } } };
}
