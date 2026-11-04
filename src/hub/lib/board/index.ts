import { basename } from "node:path";
import { titleMatchKeys } from "@app/cmux/lib/title-match";
import type {
    AgentBoardChild,
    AgentBoardPhaseRow,
    AgentBoardSession,
    AgentsBoardDto,
} from "@app/dev-dashboard/contract/agents";
import { readSessionBackward } from "@genesiscz/utils/agent-sessions/session-backward";
import { type FleetEntry, type FleetViewOptions, readFleetView } from "@genesiscz/utils/ai/live-sessions/fleet";
import { ownPromptText } from "@genesiscz/utils/ai/transcripts/prompt-parts";
import { logger } from "@genesiscz/utils/logger";
import { clipOneLine } from "@genesiscz/utils/string";
import { type AgentNode, type AgentParent, type AgentsTree, DEFAULT_AGENTS_LIMIT, hubAgents } from "../agents/index";
import { fleetStuckCheck } from "../insights/index";
import { phaseRowOf } from "./phases";

export { boardKey, diffPhases, phaseRowOf } from "./phases";

const log = logger.child({ component: "hub/board" });

/** How long a prompt or an assistant text on the board may be, after folding it to one line. */
export const BOARD_TEXT_CHARS = 200;
/** How far back from the end of a transcript the newest prompt is looked for. */
const PROMPT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What the board reads. Tests pass fakes, so no process table, cmux tree or transcript of this Mac is read.
 * `fleet` is the fleet view with the hub's stuck verdict; `tree` the hub agent tree for the given live session ids.
 */
export interface BoardDeps {
    fleet(options?: Pick<FleetViewOptions, "now">): Promise<FleetEntry[]>;
    tree(liveSessionIds: Set<string>): Promise<AgentsTree>;
    lastPrompt(entry: FleetEntry): Promise<string | null>;
    now(): number;
}

/**
 * The newest prompt in the user's own words, read from the end through its provider's reader (`readBackward`). A
 * harness delivery (a task result, a peer's message) and a compaction summary are skipped.
 */
async function newestPrompt(entry: FleetEntry): Promise<string | null> {
    if (!entry.transcript) {
        return null;
    }

    try {
        const read = await readSessionBackward({
            kind: entry.transcript.provider,
            transcriptPath: entry.transcript.filePath,
            until: (row) => row.role === "user" && ownPromptText(row.text) !== null,
            maxBytes: PROMPT_MAX_BYTES,
        });

        if (!read.found) {
            log.debug(
                { path: entry.transcript.filePath, maxBytes: PROMPT_MAX_BYTES },
                "no prompt in the transcript's tail window"
            );
            return null;
        }

        const prompt = read.entries.find((row) => row.role === "user" && ownPromptText(row.text) !== null);
        const words = prompt ? ownPromptText(prompt.text) : null;
        return words ? clipOneLine(words, BOARD_TEXT_CHARS) : null;
    } catch (error) {
        log.debug({ error, path: entry.transcript.filePath }, "newest prompt unreadable");
        return null;
    }
}

export const realBoardDeps: BoardDeps = {
    fleet: (options) => readFleetView({ ...options, stuck: fleetStuckCheck, titleKeys: titleMatchKeys }),
    tree: (ids) => hubAgents({ openSessions: async () => ids, limit: Math.max(DEFAULT_AGENTS_LIMIT, ids.size) }),
    lastPrompt: newestPrompt,
    now: () => Date.now(),
};

/** The live sessions' phases, one row each (the `agents` channel's snapshot). */
export async function readAgentPhases(deps: BoardDeps = realBoardDeps): Promise<AgentBoardPhaseRow[]> {
    return (await deps.fleet({ now: deps.now() })).map(phaseRowOf);
}

function childOf(node: AgentNode, folded: ReadonlyMap<string, FleetEntry>): AgentBoardChild {
    const live = node.nativeSessionId ? folded.get(node.nativeSessionId) : undefined;
    return {
        id: node.id,
        harness: node.harness,
        kind: node.kind,
        name: node.name ?? node.description ?? node.agentType,
        model: node.model,
        status: node.status,
        lastAt: node.lastAt,
        liveLabel: live?.label ?? null,
        children: node.children.map((child) => childOf(child, folded)),
    };
}

/** The native session ids of every child in the tree: a live session with one of them is folded under its parent. */
function childSessionIds(nodes: readonly AgentNode[], into = new Set<string>()): Set<string> {
    for (const node of nodes) {
        if (node.nativeSessionId) {
            into.add(node.nativeSessionId);
        }

        childSessionIds(node.children, into);
    }

    return into;
}

function sessionOf(input: {
    entry: FleetEntry;
    parent: AgentParent | undefined;
    lastPrompt: string | null;
    folded: ReadonlyMap<string, FleetEntry>;
}): AgentBoardSession {
    const { entry, parent, lastPrompt, folded } = input;
    const cwd = entry.cwd ?? parent?.cwd ?? null;
    return {
        ...phaseRowOf(entry),
        project: parent?.project ?? (cwd ? basename(cwd) : null),
        cwd,
        account: parent?.account ?? null,
        model: parent?.model ?? null,
        title: parent?.title ?? null,
        lastPrompt,
        lastText: entry.lastText ? clipOneLine(entry.lastText, BOARD_TEXT_CHARS) : null,
        children: (parent?.children ?? []).map((child) => childOf(child, folded)),
    };
}

/** Running turns first (stalled ones on top), then the sessions that wait for the user, then the rest, newest first. */
function rank(session: AgentBoardSession): number {
    if (session.stalled) {
        return 0;
    }

    if (session.label === "waiting" || session.label === "interrupted") {
        return 1;
    }

    if (session.label === "thinking" || session.label === "tool") {
        return 2;
    }

    return 3;
}

/**
 * Every live Claude, Codex and Grok session on this Mac with what it does now (the fleet view), joined by session id
 * with the hub agent tree for its project, account, model, title and sub-agents and workers, plus its newest prompt.
 * A live session that is a worker of another (its id is a child's native session id) is folded under that parent.
 * A live session the tree does not list keeps its fleet facts and takes its project from its working directory.
 * A DIAGNOSTIC: it reads the process table, cmux, the journal and transcript tails, and writes nothing.
 */
export async function agentsBoard(deps: BoardDeps = realBoardDeps): Promise<AgentsBoardDto> {
    const now = deps.now();
    const fleet = await deps.fleet({ now });
    const ids = new Set(fleet.flatMap((entry) => (entry.sessionId ? [entry.sessionId] : [])));
    const tree = ids.size > 0 ? await deps.tree(ids) : { generatedAt: "", parents: [], orphans: [] };
    const parents = new Map(tree.parents.map((parent) => [parent.sessionId, parent]));
    const childIds = childSessionIds(tree.parents.flatMap((parent) => parent.children));
    const folded = new Map(
        fleet.flatMap((entry) => (entry.sessionId && childIds.has(entry.sessionId) ? [[entry.sessionId, entry]] : []))
    );
    const top = fleet.filter((entry) => !entry.sessionId || !folded.has(entry.sessionId));
    const prompts = await Promise.all(top.map((entry) => deps.lastPrompt(entry)));
    const sessions = top
        .map((entry, at) =>
            sessionOf({
                entry,
                parent: entry.sessionId ? parents.get(entry.sessionId) : undefined,
                lastPrompt: prompts[at],
                folded,
            })
        )
        .sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

    log.debug({ sessions: sessions.length, parents: parents.size }, "agents board built");
    return { generatedAt: new Date(now).toISOString(), sessions };
}
