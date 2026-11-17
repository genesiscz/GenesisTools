import { readPaneReceipt } from "@app/claude/lib/cmux/pane-send";
import { execTool } from "@genesiscz/utils/cli";
import { type AgentCmuxTree, fetchAgentCmuxTree } from "@genesiscz/utils/cmux/agent-tree";
import { loadAllSessionCmuxRefs, type SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type {
    SessionHostAction,
    SessionHostActionState,
    SessionHostActResult,
    SessionHostAdapter,
    SessionHostView,
} from "../types";
import { WAKE_TEXT } from "../types";

const { log } = logger.scoped("session-host:cmux");

const PLACE = "cmux pane";
const KEEPALIVE_TEXT = "/keepalive";
/** A focus raises a window, a pane and a tab; a send waits for the pane to take the text. */
const ACTION_TIMEOUT_MS = 30_000;

/** The edges of the cmux host, so a test runs it on a fixture tree and journal and never spawns `tools`. */
export interface CmuxHostDeps {
    tree: () => Promise<AgentCmuxTree>;
    refs: () => ReadonlyMap<string, SessionCmuxRefs>;
    run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const LIVE_DEPS: CmuxHostDeps = {
    tree: () => fetchAgentCmuxTree(),
    refs: () => loadAllSessionCmuxRefs(),
    // A spawn, not a call: `tools claude cmux focus|send` end with `process.exit` on a miss, which in-process would end
    // the caller (the session-host service), and they own the stale-ref retry and the pane matcher.
    run: async (args) => execTool(args, { timeout: ACTION_TIMEOUT_MS }),
};

interface LivePane {
    workspace: string;
    tab: string;
}

/**
 * Each live surface's session, by full id, or by the 8-character id a restored tab's title carries when the journal
 * names no session for the surface. A reused tab keeps the old session's marker in its title, so a hint beside a known
 * session would claim a session that left the tab.
 */
function livePanes(tree: AgentCmuxTree): Map<string, LivePane> {
    const panes = new Map<string, LivePane>();

    for (const window of tree.windows) {
        for (const workspace of window.workspaces) {
            for (const pane of workspace.panes) {
                for (const surface of pane.surfaces) {
                    const live: LivePane = { workspace: workspace.name, tab: surface.title };

                    if (surface.sessionId) {
                        panes.set(surface.sessionId.toLowerCase(), live);
                    } else if (surface.sessionHint && !panes.has(surface.sessionHint)) {
                        panes.set(surface.sessionHint, live);
                    }
                }
            }
        }
    }

    return panes;
}

function recordedLabel(refs: SessionCmuxRefs): string {
    return [refs.workspaceRef, refs.surfaceRef].filter(Boolean).join(" · ") || "its last pane";
}

function actionsFor(state: { live: boolean | null; unreachable?: string }): SessionHostView["actions"] {
    if (state.unreachable) {
        const reason = `cmux is not reachable: ${state.unreachable}`;
        return {
            focus: { enabled: false, reason },
            wake: { enabled: false, reason },
            keepalive: { enabled: false, reason },
        };
    }

    // A recorded pane may still be there under a newer tab id: the focus command retries with its matcher.
    const focus: SessionHostActionState = { enabled: true, tip: "Raise the session's cmux pane" };

    if (!state.live) {
        const reason = "No live cmux pane holds this session.";
        return { focus, wake: { enabled: false, reason }, keepalive: { enabled: false, reason } };
    }

    return {
        focus,
        wake: { enabled: true, tip: "Type a poke into the pane" },
        keepalive: { enabled: true, tip: "Send /keepalive to the pane" },
    };
}

/** Why the CLI refused: its first non-empty stderr line, without its status glyph. */
function cliReason(stderr: string): string {
    const line = stderr
        .split("\n")
        .map((part) => part.trim())
        .find((part) => part.length > 0);

    return (line ?? "the tools CLI reported no detail").replace(/^✘\s*/, "");
}

/**
 * A button of a session window acts with no person at the matcher, so it takes only a pane that is proven to run the
 * session: `--exact` for focus and `--exact-session` for send. Without them the matcher may fall back to a topic
 * alias, to text on the screen or to another pane of the same working directory, and `--first` would take that pane.
 */
async function focus(sessionId: string, deps: CmuxHostDeps): Promise<SessionHostActResult> {
    const result = await deps.run(["claude", "cmux", "focus", sessionId, "--exact", "--first", "--json"]);
    let focused: unknown;

    try {
        const parsed: unknown = SafeJSON.parse(result.stdout, { strict: true });
        focused = typeof parsed === "object" && parsed !== null && "focused" in parsed ? parsed.focused : undefined;
    } catch (error) {
        log.debug({ error, stdout: result.stdout.slice(0, 200) }, "cmux focus printed no JSON");
    }

    if (result.exitCode === 0 && focused) {
        return { ok: true, detail: "Raised the session's cmux pane." };
    }

    return { ok: false, reason: result.stderr ? cliReason(result.stderr) : "No cmux pane holds this session." };
}

async function send(sessionId: string, text: string, deps: CmuxHostDeps): Promise<SessionHostActResult> {
    const result = await deps.run(["claude", "cmux", "send", sessionId, text, "--exact-session", "--first", "--json"]);
    const receipt = readPaneReceipt(result.stdout);

    switch (receipt.kind) {
        case "typed":
            return { ok: true, detail: `Typed "${text}" into the session's cmux pane.` };
        case "refused":
            return { ok: false, reason: receipt.reason ?? cliReason(result.stderr) };
        case "unconfirmed":
            return {
                ok: false,
                reason: `cmux did not confirm the text arrived${receipt.reason ? `: ${receipt.reason}` : ""}.`,
            };
        case "unreadable":
            return { ok: false, reason: cliReason(result.stderr) };
    }
}

const SENT_TEXT: Record<Exclude<SessionHostAction, "focus">, string> = { wake: WAKE_TEXT, keepalive: KEEPALIVE_TEXT };

/** The cmux host: a session a cmux surface runs (the live tree), or last ran (the SessionStart journal). */
export function createCmuxSessionHost(deps: CmuxHostDeps = LIVE_DEPS): SessionHostAdapter {
    return {
        kind: "cmux",
        place: PLACE,

        async describe(sessionIds) {
            // The journal keys sessions lowercased (`loadAllSessionCmuxRefs`), as the live panes are.
            const refs = deps.refs();
            const recorded = sessionIds.filter((id) => refs.has(id.toLowerCase()));
            const tree = await deps.tree();
            const live = tree.available ? livePanes(tree) : new Map<string, LivePane>();
            const views = new Map<string, SessionHostView>();

            for (const sessionId of sessionIds) {
                const key = sessionId.toLowerCase();
                const pane = live.get(key) ?? live.get(key.slice(0, 8));
                const journal = refs.get(key);

                if (pane) {
                    views.set(sessionId, {
                        kind: "cmux",
                        place: PLACE,
                        label: [pane.workspace, pane.tab].filter(Boolean).join(" · "),
                        live: true,
                        note: "Waiting in a cmux pane",
                        actions: actionsFor({ live: true }),
                    });
                    continue;
                }

                if (!journal) {
                    continue;
                }

                const unreachable = tree.available ? undefined : (tree.error ?? "no answer");
                views.set(sessionId, {
                    kind: "cmux",
                    place: PLACE,
                    label: recordedLabel(journal),
                    live: unreachable ? null : false,
                    note: unreachable ? "cmux is not reachable" : "Its cmux pane is closed",
                    actions: actionsFor({ live: false, unreachable }),
                });
            }

            log.debug(
                { asked: sessionIds.length, recorded: recorded.length, held: views.size, available: tree.available },
                "sessions held by cmux panes"
            );
            return views;
        },

        async act(action, sessionId) {
            if (action === "focus") {
                return focus(sessionId, deps);
            }

            return send(sessionId, SENT_TEXT[action], deps);
        },
    };
}

export const cmuxSessionHost: SessionHostAdapter = createCmuxSessionHost();
