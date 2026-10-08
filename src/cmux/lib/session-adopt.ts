import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";
import { isSessionAgentId, type SessionAgentId } from "./session-agents";
import type { AdoptedSession } from "./session-close";

export interface LiveSurface {
    ref: string;
    tty: string | null;
    workspace: string;
    window: string;
}

export interface CmuxTreeView {
    /** The surface this command runs in; never adopted. */
    caller: string | null;
    surfaces: Map<string, LiveSurface>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** The terminal surfaces of `cmux tree --json`, keyed by ref, with their tty, workspace and window. */
export function parseCmuxTree(stdout: string): CmuxTreeView {
    const parsed: unknown = SafeJSON.parse(stdout, { strict: true });
    const surfaces = new Map<string, LiveSurface>();

    if (!isRecord(parsed)) {
        return { caller: null, surfaces };
    }

    const caller = isRecord(parsed.caller) ? text(parsed.caller.surface_ref) : null;

    for (const window of list(parsed.windows)) {
        if (!isRecord(window) || !text(window.ref)) {
            continue;
        }

        for (const workspace of list(window.workspaces)) {
            if (!isRecord(workspace) || !text(workspace.ref)) {
                continue;
            }

            for (const pane of list(workspace.panes)) {
                if (!isRecord(pane)) {
                    continue;
                }

                for (const surface of list(pane.surfaces)) {
                    const ref = isRecord(surface) ? text(surface.ref) : null;

                    if (isRecord(surface) && ref && surface.type === "terminal") {
                        surfaces.set(ref, {
                            ref,
                            tty: text(surface.tty),
                            workspace: String(workspace.ref),
                            window: String(window.ref),
                        });
                    }
                }
            }
        }
    }

    return { caller, surfaces };
}

/**
 * The live agent session a query names, from the cmux-refs journal joined with the live tree.
 *
 * The query is a session id (or a prefix of 8+ characters), a surface ref, or a workspace ref. Only the
 * newest session per surface counts (a surface that ran several sessions holds the last one), only
 * surfaces cmux still lists count, and the caller's own surface never does. A workspace ref adopts only
 * when exactly one agent session lives in it. `providerOf` names the agent; an entry it cannot name is
 * skipped rather than guessed, because `/exit` typed into the wrong agent is not harmless.
 */
export function pickAdoptable(input: {
    query: string;
    refs: Iterable<SessionCmuxRefs>;
    tree: CmuxTreeView;
    providerOf: (entry: SessionCmuxRefs) => string | undefined;
}): AdoptedSession | null {
    const newestBySurface = new Map<string, SessionCmuxRefs>();

    for (const entry of input.refs) {
        const surface = entry.surfaceRef;

        if (!surface || !input.tree.surfaces.has(surface) || surface === input.tree.caller) {
            continue;
        }

        const seen = newestBySurface.get(surface);

        if (!seen || entry.at > seen.at) {
            newestBySurface.set(surface, entry);
        }
    }

    const needle = input.query.trim().toLowerCase();
    const hits = [...newestBySurface.values()].filter((entry) => {
        const live = input.tree.surfaces.get(entry.surfaceRef ?? "");
        const id = entry.sessionId.toLowerCase();
        return (
            id === needle ||
            (needle.length >= 8 && id.startsWith(needle)) ||
            entry.surfaceRef === input.query ||
            live?.workspace === input.query
        );
    });

    if (hits.length !== 1) {
        return null;
    }

    const entry = hits[0];
    const agent = input.providerOf(entry);
    const live = input.tree.surfaces.get(entry.surfaceRef ?? "");

    if (!agent || !isSessionAgentId(agent) || !live) {
        return null;
    }

    return adoptedFrom(entry, live, agent);
}

function adoptedFrom(entry: SessionCmuxRefs, live: LiveSurface, agent: SessionAgentId): AdoptedSession {
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
        tmuxSession: null,
        pidFile: "",
        command: "",
        createdAt: new Date(entry.at).toISOString(),
        createdBy: "adopted",
        tty: live.tty,
    };
}

/** Does a `ps -t <tty> -o args=` listing show the agent? Its binary, or the `tools <agent>` launcher. */
export function ttyRunsAgent(psArgs: string, agent: SessionAgentId): boolean {
    const word = new RegExp(`(^|[\\s/])${agent}(\\s|$)`);
    return psArgs.split("\n").some((line) => word.test(line.trim()));
}
