import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionOpenDialog } from "@app/claude/lib/cmux/dialog-guard";
import { type FocusTarget, isUnambiguous } from "@app/claude/lib/cmux/focus";
import { type PaneReceipt, readPaneReceipt } from "@app/claude/lib/cmux/pane-send";
import {
    findSessionTargets,
    identifiesExactSession,
    type SessionTargetsResult,
    SOFT_SOURCES,
} from "@app/claude/lib/cmux/resolve";
import { ClaudeWorkerStore, claudeWorkerSourceHome } from "@app/claude/lib/worker/store";
import { isCodexDaemonPid } from "@app/codex/lib/spawn";
import { CodexSessionStore, codexWorkerHome } from "@app/codex/lib/store";
import { type GrokLeaderClient, leaderSocketsFor, sendToGrokLeader } from "@app/grok/lib/leader";
import { GrokSessionStore } from "@app/grok/lib/store";
import { canonicalAgent } from "@app/handoff/targeting";
import {
    enqueueSessionMessage,
    findKeyedSessionMessage,
    MAX_SESSION_MESSAGE_BYTES,
    SessionMessageTooLargeError,
    sessionMessageTextHash,
} from "@genesiscz/utils/agent-sessions/message-queue";
import { dialogRefusal } from "@genesiscz/utils/agents/dialogs/guard";
import type { DialogProvider, OpenDialog } from "@genesiscz/utils/agents/dialogs/types";
import { type AccountProviderAlias, isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessWorker } from "@genesiscz/utils/ai/providers/harness-index";
import {
    type ClaudeLiveSession,
    claudeSessionsDir,
    listClaudeSessionInventory,
    type PeerSenderMode,
    readPeerToken,
    sendClaudePeerMessage,
} from "@genesiscz/utils/claude/peer-message";
import { sessionSenderMode, standInSender } from "@genesiscz/utils/claude/peer-sender";
import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type CmuxLiveSnapshot, fetchCmuxLiveSnapshot } from "@genesiscz/utils/cmux/lib/live-snapshot";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { runsAgent } from "@genesiscz/utils/process/classify";
import { batchPsInfo } from "@genesiscz/utils/process/ps";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { workerSourceHome } from "@genesiscz/utils/worker/delivery";
import type { WorkerMetaStore } from "@genesiscz/utils/worker/meta-store";
import { z } from "zod";
import { DeliveryUnknownError, NotDeliveredError } from "./delivery-errors";
import { deliverySentence } from "./delivery-text";

export { DeliveryUnknownError, NotDeliveredError };

const { log } = logger.scoped("question-deliver");

/**
 * How the answers reach the agent: typed into its cmux pane, steered into its Codex worker, sent
 * as the first prompt of a resumed session, prompted through the Grok leader the session runs in,
 * or left for its next prompt.
 */
/** `prompt`: the session sent the answers itself, through its own prompt (the mods Decisions sidebar). */
export type DeliveryChannel = "cmux" | "codex" | "claude-peer" | "grok-leader" | "resume" | "queued" | "prompt";

export interface DeliveryResult {
    channel: DeliveryChannel;
    delivered: boolean;
    /** A short human place the answers went: `cmux · agents-window · pane 1`, `codex worker w1`. */
    target?: string;
    /** One sentence saying why nothing was delivered, for the user. */
    error?: string;
    /** The tool's raw output behind the sentence; logged, shown behind a disclosure, never stored. */
    raw?: string;
    queueId?: string;
    queueTextHash?: string;
}

export interface ToolRun {
    success: boolean;
    stdout: string;
    stderr: string;
}

/** Runs `tools <args>` and waits at most `timeoutMs`; the route that runs it knows how long its send may take. */
export type ToolRunner = (args: string[], options: { timeoutMs: number }) => Promise<ToolRun>;

/** A quick send: the cmux pane, a Codex steer (it acknowledges the input, it does not wait for the turn). */
const SEND_TIMEOUT_MS = 60_000;
/** A worker steer resumes a whole turn and waits for it, so it gets a turn's time. */
const TURN_TIMEOUT_MS = 15 * 60_000;

function liveClaudePeers(session: string, sourceHome?: string): ClaudeLiveSession[] {
    const directory = sourceHome ? join(workerSourceHome(sourceHome), "sessions") : claudeSessionsDir();
    const candidates = listClaudeSessionInventory({ dir: directory, liveOf: (pids) => new Set(pids) }).filter(
        (peer) => peer.sessionId === session
    );
    const processes = batchPsInfo(candidates.map((peer) => peer.pid));
    return candidates.filter((peer) => {
        const process = processes.get(peer.pid);
        return process && runsAgent(process.command, "claude");
    });
}

/** A receiver this much more recent than every other copy of the session is the copy in use. */
export const ACTIVE_RECEIVER_LEAD_MS = 10 * 60_000;

/**
 * One Claude session resumed in two terminals has two live receivers. The one whose registry entry moved last, by
 * at least `ACTIVE_RECEIVER_LEAD_MS`, is the copy the user works in (the other sat idle for hours on 2026-10-24, and
 * every send was queued). Closer than that, nothing tells them apart: the reason names both processes.
 */
export function pickClaudePeer(
    peers: readonly ClaudeLiveSession[]
): { peer: ClaudeLiveSession; others: number } | { reason: string } {
    const ranked = peers.filter((peer) => !peer.parkedJobId).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const [first, second] = ranked;
    if (!first) {
        return {
            reason:
                peers.length > 0
                    ? "This Claude session is parked in a background job; its old terminal is not a receiver."
                    : "No native Claude receiver claims this session.",
        };
    }

    const knownActivity = ranked.every(
        (peer) => typeof peer.updatedAt === "number" && Number.isFinite(peer.updatedAt) && peer.updatedAt > 0
    );
    if (!second || (knownActivity && (first.updatedAt ?? 0) - (second.updatedAt ?? 0) >= ACTIVE_RECEIVER_LEAD_MS)) {
        return { peer: first, others: ranked.length - 1 };
    }

    const pids = ranked.map((peer) => `pid ${peer.pid}`).join(", ");
    return {
        reason: `${ranked.length} Claude terminals run this session (${pids}), ${knownActivity ? "active within 10 minutes of each other" : "with unknown activity on at least one copy"}; none was picked. Close the extra one, then send again.`,
    };
}

/** Where a send would go, resolved before anything is typed. */
export type DeliveryTarget =
    | {
          kind: "cmux";
          label: string;
          workspaceId: string;
          workspaceName: string;
          paneId: string;
          paneTitle: string;
          surfaceId: string;
      }
    | { kind: "codex"; label: string; worker: string }
    | { kind: "worker"; label: string; worker: NativeDeliveryWorker }
    | { kind: "claude-peer"; label: string; peer: ClaudeLiveSession }
    /** The Grok leader sockets that may hold the session; which one does is asked when the answer is sent. */
    | { kind: "grok-leader"; label: string; sockets: string[] }
    | { kind: "none"; reason: string };

type NoTarget = Extract<DeliveryTarget, { kind: "none" }>;
type TargetOf<Kind extends DeliveryTarget["kind"]> = Extract<DeliveryTarget, { kind: Kind }>;

export interface NativeDeliveryWorker {
    /** A harness whose answer route resumes a session by a worker turn (`ANSWER_ROUTES[provider].ownedWorkers`). */
    provider: AccountProviderAlias;
    name: string;
    sessionId: string;
    sourceHome: string;
    turns: number;
    ready: boolean;
    reason?: string;
}

function busy(active?: { ownerPid: number; childPid?: number }): boolean {
    return Boolean(active && (isProcessAlive(active.ownerPid) || (active.childPid && isProcessAlive(active.childPid))));
}

/** The meta fields every owned worker store keeps, which the delivery reads. */
interface OwnedWorkerMeta {
    name: string;
    sessionId: string;
    turns: number;
    activeTurn?: { ownerPid: number; childPid?: number };
}

/** The owned headless workers of one harness, each with whether it can take another turn now. */
function ownedWorkers<Meta extends OwnedWorkerMeta>({
    provider,
    label,
    store,
    sourceHome,
    started,
}: {
    provider: AccountProviderAlias;
    label: string;
    store: WorkerMetaStore<Meta>;
    sourceHome: (meta: Meta) => string;
    /** Whether the worker's original session exists, so a resumed turn continues it rather than starting one. */
    started: (meta: Meta) => boolean;
}): NativeDeliveryWorker[] {
    return store.listNames().flatMap((name) => {
        const meta = store.readMeta(name);
        if (!meta) {
            return [];
        }

        const running = busy(meta.activeTurn);
        return [
            {
                provider,
                name,
                sessionId: meta.sessionId,
                sourceHome: sourceHome(meta),
                turns: meta.turns,
                ready: !running && started(meta),
                reason: running
                    ? `The ${label} worker is busy; the answer remains queued for a later turn.`
                    : `The original ${label} worker session has not started.`,
            },
        ];
    });
}

/**
 * Everything the delivery reads from or writes to the machine. `LIVE_EDGES` is the real machine; a caller replaces
 * the edges it scripts (the widget its `tools` transport, a test its fakes), and the rest stay live.
 */
interface DeliveryEdges {
    /** Runs `tools <args>`: the worker steers and the cmux pane send. */
    runTool: ToolRunner;
    /** The `tools codex` worker name that runs this Codex thread, or null. */
    codexWorkerFor: (sessionId: string, sourceHome?: string) => string | null;
    nativeWorkers: (provider: AccountProviderAlias) => NativeDeliveryWorker[];
    /** The live Claude receivers of the session in a source home (the default home when none is given). */
    claudePeers: (sourceHome: string | undefined, sessionId: string) => ClaudeLiveSession[];
    sendClaudePeer: typeof sendClaudePeerMessage;
    /** The receiving Claude session's permission class; read from its transcript. */
    receiverMode: (sessionId: string) => Promise<PeerSenderMode | null>;
    peerToken: typeof readPeerToken;
    /** The cmux panes a session runs in. */
    findTargets: (sessionId: string, opts: { skipRecorded?: boolean }) => Promise<SessionTargetsResult>;
    /** Is a dialog open in the receiving session? Asked before text is typed into a pane. */
    openDialog: (input: OpenDialogInput) => Promise<OpenDialog | null> | OpenDialog | null;
    /** The Grok leader sockets to ask for a session (its record's, then the default). */
    grokLeaderSockets: (sessionId: string) => string[];
    /** An ACP client on one leader socket; the leader module's own client when absent. */
    grokLeaderClient?: (socket: string) => GrokLeaderClient;
}

export type DeliverDeps = Partial<DeliveryEdges> & {
    /** The durable session queue's root; the shared one when absent. */
    queueRoot?: string;
};

export interface OpenDialogInput {
    provider: DialogProvider;
    sessionId: string;
    sourceHome?: string;
}

function codexWorkerFor(sessionId: string, sourceHome?: string): string | null {
    const store = new CodexSessionStore();

    for (const name of store.listNames()) {
        const meta = store.readMeta(name);

        if (!meta || meta.status === "closed" || meta.status === "failed") {
            continue;
        }

        // A meta keeps `ready` after its daemon was killed; steering it is refused, so it is no route.
        if (!isCodexDaemonPid(meta.daemonPid, name)) {
            continue;
        }

        const sameHome = !sourceHome || workerSourceHome(sourceHome) === workerSourceHome(codexWorkerHome(meta));
        if (meta.threadId === sessionId && sameHome) {
            return name;
        }
    }

    return null;
}

const LIVE_EDGES: DeliveryEdges = {
    runTool: (args, { timeoutMs }) => execTool(args, { timeout: timeoutMs }),
    codexWorkerFor,
    nativeWorkers: (provider) => ANSWER_ROUTES[provider].ownedWorkers(),
    claudePeers: (sourceHome, sessionId) => liveClaudePeers(sessionId, sourceHome),
    sendClaudePeer: sendClaudePeerMessage,
    receiverMode: sessionSenderMode,
    peerToken: readPeerToken,
    findTargets: (sessionId, opts) => findSessionTargets(sessionId, opts),
    // State signals only (the hook records, then the transcript's turn state), the same guard `cmux send` asks.
    openDialog: (input) => sessionOpenDialog({ sessionId: input.sessionId, provider: input.provider }),
    grokLeaderSockets: (sessionId) => leaderSocketsFor(sessionId),
};

/** The caller's edges over the live ones; an edge given as undefined stays live. */
function edgesOf(deps: DeliverDeps): DeliveryEdges {
    return {
        runTool: deps.runTool ?? LIVE_EDGES.runTool,
        codexWorkerFor: deps.codexWorkerFor ?? LIVE_EDGES.codexWorkerFor,
        nativeWorkers: deps.nativeWorkers ?? LIVE_EDGES.nativeWorkers,
        claudePeers: deps.claudePeers ?? LIVE_EDGES.claudePeers,
        sendClaudePeer: deps.sendClaudePeer ?? LIVE_EDGES.sendClaudePeer,
        receiverMode: deps.receiverMode ?? LIVE_EDGES.receiverMode,
        peerToken: deps.peerToken ?? LIVE_EDGES.peerToken,
        findTargets: deps.findTargets ?? LIVE_EDGES.findTargets,
        openDialog: deps.openDialog ?? LIVE_EDGES.openDialog,
        grokLeaderSockets: deps.grokLeaderSockets ?? LIVE_EDGES.grokLeaderSockets,
        grokLeaderClient: deps.grokLeaderClient,
    };
}

const LABEL_MAX = 40;

function short(name: string): string {
    const trimmed = name.trim();
    return trimmed.length > LABEL_MAX ? `${trimmed.slice(0, LABEL_MAX - 1)}…` : trimmed;
}

/** `cmux · <workspace> · <pane>`, with the names the tree shows, never the ids alone when a name exists. */
export function cmuxLabel(workspaceName: string, paneTitle: string): string {
    return ["cmux", short(workspaceName), short(paneTitle)].filter((part) => part.length > 0).join(" · ");
}

/** Whether the target's surface (or pane) is in the live snapshot: a recorded ref can outlive its workspace. */
function isLive(target: FocusTarget, snapshot: CmuxLiveSnapshot | undefined): boolean {
    if (!snapshot) {
        return true;
    }

    return snapshot.panes.some(
        (pane) =>
            (target.surfaceId && pane.surfaces.some((surface) => surface.id === target.surfaceId)) ||
            (!target.surfaceId && pane.id === target.paneId && pane.workspaceId === target.workspaceId)
    );
}

function named(target: FocusTarget, snapshot: CmuxLiveSnapshot | undefined): TargetOf<"cmux"> {
    const pane = snapshot?.panes.find((candidate) => candidate.id === target.paneId);
    const workspace = snapshot?.workspaces.find(
        (candidate) => candidate.id === (pane?.workspaceId ?? target.workspaceId)
    );
    const surface = pane?.surfaces.find((candidate) => candidate.id === target.surfaceId);
    const workspaceName = workspace?.name || target.workspaceName;
    const paneTitle = surface?.title || target.paneTitle || target.paneId;

    return {
        kind: "cmux",
        label: cmuxLabel(workspaceName, paneTitle),
        workspaceId: pane?.workspaceId ?? target.workspaceId,
        workspaceName,
        paneId: target.paneId,
        paneTitle,
        surfaceId:
            target.surfaceId ??
            pane?.selectedSurfaceId ??
            pane?.surfaces.find((candidate) => candidate.selected)?.id ??
            "",
    };
}

/** A decision row's provider as a harness; the runtime context spells Claude `claude-code`. */
function nativeHarness(provider: string | undefined): AccountProviderAlias | undefined {
    const name = provider ? (canonicalAgent(provider) ?? provider) : undefined;
    return name && isAccountProviderAlias(name) ? name : undefined;
}

interface RouteQuery {
    session: string;
    sourceHome?: string;
}

/** What one route is asked to deliver. */
interface RouteMessage extends RouteQuery {
    text: string;
    /** The session's harness, when the caller knows it: the pane route's dialog guard needs it. */
    harness?: AccountProviderAlias;
    /** Type into the pane even while a dialog is open there. The structural routes never need it. */
    force: boolean;
}

/** What one send through a route came to. Each route reads its own receipt into exactly one of these. */
type SendOutcome =
    | { kind: "delivered"; channel: DeliveryChannel; target: string }
    /** Proven before any input: nothing reached the session. The durable session queue may keep the message. */
    | { kind: "refused"; reason: string; raw?: string }
    /** Proven before any input: the route does not hold the session after all, so the next route is tried. */
    | { kind: "absent"; reason: string }
    /** Attempted, and no receipt says whether it arrived: never resent automatically (`DeliveryUnknownError`). */
    | { kind: "unknown"; reason: string }
    /**
     * The pane send failed and printed nothing readable. Reported as not delivered, and not saved for a later
     * replay, since nothing proves it failed before any input.
     */
    | { kind: "failed"; reason: string; raw: string };

/** A route that holds the session: the place it found, and the send bound to it. */
interface RouteHit {
    target: Exclude<DeliveryTarget, NoTarget>;
    send(message: RouteMessage): Promise<SendOutcome>;
}

/**
 * One way a harness's answers travel. `find` answers whether the route holds the session: undefined passes to the
 * next route, a `none` target stops the ladder (the route holds the session but cannot take the answer now), and a
 * hit carries the send that reads the route's own receipt.
 */
interface AnswerRoute {
    find(query: RouteQuery, edges: DeliveryEdges): Promise<RouteHit | NoTarget | undefined>;
}

function isHit(found: RouteHit | NoTarget): found is RouteHit {
    return "send" in found;
}

/** The `tools` verb that steers a harness's worker, read from its driver's worker verbs (`steer`, `worker steer`). */
function steerCommand(harness: AccountProviderAlias): string[] {
    const verb = harnessWorker(harness).verbs.find((entry) => entry.split(" ").at(-1) === "steer");

    if (!verb) {
        throw new Error(`The ${harness} worker lists no steer verb.`);
    }

    // A harness's `tools` command is named after it (`tools claude worker steer`, `tools codex steer`).
    return [harness, ...verb.split(" ")];
}

/** Writes the text to a private prompt file for one run, and removes it after the run, whatever it returned. */
async function withPromptFile<T>(text: string, run: (promptFile: string) => Promise<T>): Promise<T> {
    const directory = mkdtempSync(join(tmpdir(), "worker-delivery-"));
    try {
        const promptFile = join(directory, "prompt.txt");
        writeFileSync(promptFile, text, { mode: 0o600 });
        return await run(promptFile);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

/**
 * The `--json` receipt of a worker steer, any harness. A refusal is `kind: "rejected"` with the worker's backend,
 * name and error. A Claude or Grok steer answers with its completed turn; a Codex steer with its input acknowledgement
 * (`queued: false` and the provider's `turnId`) or its daemon queue (`queued: true`).
 */
const steerReceiptSchema = z.looseObject({
    kind: z.string().optional(),
    backend: z.string().optional(),
    name: z.string().optional(),
    error: z.string().optional(),
    completed: z.boolean().optional(),
    exitCode: z.number().optional(),
    sessionId: z.string().optional(),
    sourceHome: z.string().optional(),
    turn: z.number().optional(),
    queued: z.boolean().optional(),
    turnId: z.string().optional(),
});

type SteerReceipt = z.infer<typeof steerReceiptSchema>;

/** The steer receipt, `invalid` for JSON that is no receipt object, or `unreadable` for output that is no JSON. */
function readSteerReceipt(stdout: string): SteerReceipt | "invalid" | "unreadable" {
    let raw: unknown;
    try {
        raw = SafeJSON.parse(stdout, { strict: true });
    } catch (error) {
        log.warn({ error, stdout: stdout.slice(0, 200) }, "a worker steer printed no JSON receipt");
        return "unreadable";
    }

    const parsed = steerReceiptSchema.safeParse(raw);
    return parsed.success ? parsed.data : "invalid";
}

/** The refusal a steer receipt names for this exact worker, or undefined when it names none. */
function steerRefusal(receipt: SteerReceipt, worker: { backend: string; name: string }): SendOutcome | undefined {
    return receipt.kind === "rejected" &&
        receipt.backend === worker.backend &&
        receipt.name === worker.name &&
        receipt.error !== undefined
        ? { kind: "refused", reason: receipt.error }
        : undefined;
}

/**
 * An owned Claude or Grok worker that runs this session, when one does. Its steer resumes the session by one turn,
 * and only a completed same-session, same-home, next-turn receipt counts as delivered.
 */
function ownedWorkerRoute(provider: AccountProviderAlias): AnswerRoute {
    return {
        async find({ session, sourceHome }, edges) {
            const owned = edges
                .nativeWorkers(provider)
                .filter((worker) => worker.provider === provider && worker.sessionId === session);
            const matching = owned.filter(
                (worker) => !sourceHome || workerSourceHome(worker.sourceHome) === workerSourceHome(sourceHome)
            );
            if (owned.length > 0 && matching.length !== 1) {
                return {
                    kind: "none",
                    reason:
                        matching.length > 1
                            ? "Several owned workers match this session; none was picked."
                            : "The owned worker belongs to another source home; no prompt was sent.",
                };
            }

            const worker = matching[0];
            if (!worker) {
                return undefined;
            }

            if (!worker.ready) {
                return { kind: "none", reason: worker.reason ?? "The worker is not ready for another turn." };
            }

            const target: TargetOf<"worker"> = {
                kind: "worker",
                label: `${worker.provider} worker ${worker.name}`,
                worker,
            };
            return { target, send: (message) => steerOwnedWorker(target, message, edges) };
        },
    };
}

async function steerOwnedWorker(
    target: TargetOf<"worker">,
    { session, text }: RouteMessage,
    edges: DeliveryEdges
): Promise<SendOutcome> {
    const { worker } = target;
    const result = await withPromptFile(text, (promptFile) =>
        edges.runTool(
            [
                ...steerCommand(worker.provider),
                "--name",
                worker.name,
                "--prompt-file",
                promptFile,
                "--json",
                "--expect-session",
                worker.sessionId,
                "--expect-home",
                worker.sourceHome,
                "--expect-turn",
                String(worker.turns),
            ],
            { timeoutMs: TURN_TIMEOUT_MS }
        )
    );
    const receipt = readSteerReceipt(result.stdout);

    if (receipt === "unreadable") {
        return {
            kind: "unknown",
            reason: "The resumed worker returned no readable receipt. Check its conversation before retrying.",
        };
    }

    if (receipt === "invalid") {
        return {
            kind: "unknown",
            reason: "The resumed worker returned an invalid receipt. Check its conversation before retrying.",
        };
    }

    const refusal = steerRefusal(receipt, { backend: worker.provider, name: worker.name });
    if (refusal) {
        return refusal;
    }

    if (
        result.success &&
        receipt.backend === worker.provider &&
        receipt.name === worker.name &&
        receipt.kind === "turn" &&
        receipt.completed === true &&
        receipt.exitCode === 0 &&
        receipt.sessionId === worker.sessionId &&
        receipt.sourceHome !== undefined &&
        workerSourceHome(receipt.sourceHome) === workerSourceHome(worker.sourceHome) &&
        receipt.turn === worker.turns + 1
    ) {
        log.info(
            { session, provider: worker.provider, worker: worker.name, turn: receipt.turn },
            "Answer acknowledged by completed same-session worker turn"
        );
        return { kind: "delivered", channel: "resume", target: `${target.label} · resumed turn ${receipt.turn}` };
    }

    return {
        kind: "unknown",
        reason: "The resumed worker did not acknowledge this exact session and turn. Check its conversation before retrying.",
    };
}

/** The one live Claude receiver that claims the session in the source home, the reason none does, or undefined. */
function claimingPeer(
    { session, sourceHome }: RouteQuery,
    edges: DeliveryEdges
): { peer: ClaudeLiveSession; others: number } | NoTarget | undefined {
    const matching = edges.claudePeers(sourceHome, session).filter((peer) => peer.sessionId === session);
    if (matching.length === 0) {
        return undefined;
    }

    const picked = pickClaudePeer(matching);
    if ("reason" in picked) {
        return { kind: "none", reason: picked.reason };
    }

    if (sourceHome && workerSourceHome(dirname(dirname(picked.peer.file))) !== workerSourceHome(sourceHome)) {
        return { kind: "none", reason: "The native Claude receiver belongs to another source home." };
    }

    return picked;
}

/** The live Claude session itself, through its peer socket. A dialog cannot swallow a socket message. */
const claudePeerRoute: AnswerRoute = {
    async find(query, edges) {
        const claimed = claimingPeer(query, edges);
        if (!claimed || "kind" in claimed) {
            return claimed;
        }

        const { peer, others } = claimed;
        const target: TargetOf<"claude-peer"> = {
            kind: "claude-peer",
            label:
                others > 0
                    ? `the Claude terminal active last (pid ${peer.pid}; ${others} older copy idle)`
                    : "original Claude session",
            peer,
        };
        return { target, send: (message) => sendToClaudePeer(target, message, edges) };
    },
};

async function sendToClaudePeer(
    target: TargetOf<"claude-peer">,
    message: RouteMessage,
    edges: DeliveryEdges
): Promise<SendOutcome> {
    const { session, text } = message;
    // The same lookup again, right before the write: a receiver that changed since `find` gets nothing.
    const again = claimingPeer(message, edges);
    if (
        !again ||
        "kind" in again ||
        again.peer.pid !== target.peer.pid ||
        again.peer.socketPath !== target.peer.socketPath ||
        again.peer.file !== target.peer.file
    ) {
        return {
            kind: "refused",
            reason: "The native Claude receiver changed before delivery; no message was written.",
        };
    }

    // A receiver in bypass holds a plain frame for approval, so the answer goes out with a stand-in sender of
    // the same class, as `tools claude message` attests one (DECISION 25 a)). Any other receiver gets the plain
    // frame, as before.
    const receiverMode = await edges.receiverMode(session);
    const sender = receiverMode === "bypass" ? standInSender("bypass") : null;
    try {
        await edges.sendClaudePeer({
            session: target.peer,
            text,
            token: edges.peerToken(target.peer, dirname(target.peer.file)),
            priority: "next",
            sender,
            timeoutMs: 5_000,
        });
    } catch (error) {
        log.warn({ session, pid: target.peer.pid, error }, "native Claude peer delivery has an unknown outcome");
        return {
            kind: "unknown",
            reason: "The native Claude message may have been received. Inspect the conversation before retrying.",
        };
    }

    log.info(
        { session, pid: target.peer.pid, receiverMode, attested: sender !== null },
        "native Claude peer message flushed"
    );
    // This confirms a complete transport write, not an agent-processing acknowledgement.
    // DECISION remains sent until the receiving agent records acknowledged/implemented.
    return { kind: "delivered", channel: "claude-peer", target: target.label };
}

/**
 * The Grok leader the session may run in (`tools cmux agents new grok` records its socket; the default socket is
 * asked too). Only a socket file that exists counts, so a session with no leader falls through to cmux at once.
 * A leader that does not hold the session is `absent`, and the guarded pane is the next rung.
 */
const grokLeaderRoute: AnswerRoute = {
    async find({ session }, edges) {
        const sockets = edges.grokLeaderSockets(session);
        if (sockets.length === 0) {
            return undefined;
        }

        const target: TargetOf<"grok-leader"> = { kind: "grok-leader", label: "Grok leader", sockets };
        return {
            target,
            async send({ text }) {
                const sent = await sendToGrokLeader(
                    { sessionId: session, text },
                    { sockets: () => sockets, ...(edges.grokLeaderClient ? { client: edges.grokLeaderClient } : {}) }
                );

                if (sent.kind === "delivered") {
                    // The leader queued the prompt in this exact session; the turn runs there and the TUI renders it.
                    return {
                        kind: "delivered",
                        channel: "grok-leader",
                        target: `Grok leader · session ${sent.sessionId}${sent.promptId ? ` · prompt ${sent.promptId}` : ""}`,
                    };
                }

                if (sent.kind === "unknown") {
                    return {
                        kind: "unknown",
                        reason: "The Grok leader may have queued the answer without acknowledging it. Check the conversation before retrying.",
                    };
                }

                return { kind: "absent", reason: sent.reason };
            },
        };
    },
};

/** The backend a `tools codex steer` receipt names: the Codex route's own worker. */
const CODEX_WORKER_BACKEND: AccountProviderAlias = "codex";

/**
 * A `tools codex` worker that runs the thread, the only Codex route (a Codex session is never typed into). Only a
 * provider input acknowledgement counts as delivered.
 */
const codexWorkerRoute: AnswerRoute = {
    async find({ session, sourceHome }, edges) {
        const worker = edges.codexWorkerFor(session, sourceHome);
        if (!worker) {
            return { kind: "none", reason: `no live ${toolCommand("codex")} worker runs this thread` };
        }

        const target: TargetOf<"codex"> = { kind: "codex", label: `codex worker ${worker}`, worker };
        return { target, send: (message) => steerCodexWorker(target, message, edges) };
    },
};

async function steerCodexWorker(
    target: TargetOf<"codex">,
    { session, sourceHome, text }: RouteMessage,
    edges: DeliveryEdges
): Promise<SendOutcome> {
    const steered = await withPromptFile(text, (promptFile) =>
        edges.runTool(
            [
                ...steerCommand(CODEX_WORKER_BACKEND),
                "--name",
                target.worker,
                "--json",
                "--prompt-file",
                promptFile,
                ...(sourceHome ? ["--expect-session", session, "--expect-home", sourceHome] : []),
            ],
            { timeoutMs: SEND_TIMEOUT_MS }
        )
    );
    log.info({ session, worker: target.worker, ok: steered.success }, "decision answers steered into codex");
    const receipt = readSteerReceipt(steered.stdout);

    if (receipt === "unreadable") {
        return {
            kind: "unknown",
            reason: "Codex returned no input acknowledgement. Check the conversation before retrying.",
        };
    }

    const refusal =
        receipt === "invalid"
            ? undefined
            : steerRefusal(receipt, { backend: CODEX_WORKER_BACKEND, name: target.worker });
    if (refusal) {
        return refusal;
    }

    if (steered.success && receipt !== "invalid" && receipt.queued === false && receipt.turnId) {
        // `steerCodexMessage` reports this receipt as `delivered: false`, because there `delivered` means
        // consumer-acknowledged (run.test.ts). For a Decision answer an acknowledged provider turn is enough to mark
        // the batch sent, so it maps to delivered here.
        return {
            kind: "delivered",
            channel: "codex",
            target: `${target.label} · input acknowledged (turn ${receipt.turnId})`,
        };
    }

    if (steered.success && receipt !== "invalid" && receipt.queued === true) {
        return {
            kind: "unknown",
            reason: "Codex accepted the message into its daemon queue, but has not acknowledged a provider turn. Do not resend before checking the conversation.",
        };
    }

    return {
        kind: "unknown",
        reason: "Codex did not return a valid input acknowledgement. Check the conversation before retrying.",
    };
}

/** How one harness's answers travel before the cmux pane. */
interface HarnessAnswer {
    /** The routes, tried in order; the cmux pane comes after them. */
    routes: readonly AnswerRoute[];
    /** The owned headless workers that resume a session by a worker turn (the `ownedWorkerRoute` reads them). */
    ownedWorkers(): NativeDeliveryWorker[];
}

/**
 * Each harness's answer routes: the drivers' tool-owned `answer` part (each driver names this module), the one table
 * keyed by harness in the delivery code. Codex only through its `tools codex` worker (it is never typed into, so its
 * route answers `none` rather than passing on, and it lists no owned workers: that worker is the route); Claude
 * through an owned worker, then its own peer socket; Grok through an owned worker, then the leader its TUI runs in.
 */
const ANSWER_ROUTES: { readonly [Id in AccountProviderAlias]: HarnessAnswer } = {
    claude: {
        routes: [ownedWorkerRoute("claude"), claudePeerRoute],
        ownedWorkers: () =>
            ownedWorkers({
                provider: "claude",
                label: "Claude",
                store: new ClaudeWorkerStore(),
                sourceHome: claudeWorkerSourceHome,
                started: (meta) => meta.turns > 0,
            }),
    },
    codex: { routes: [codexWorkerRoute], ownedWorkers: () => [] },
    grok: {
        routes: [ownedWorkerRoute("grok"), grokLeaderRoute],
        ownedWorkers: () =>
            ownedWorkers({
                provider: "grok",
                label: "Grok",
                store: new GrokSessionStore(),
                sourceHome: (meta) => meta.workerHome,
                started: (meta) => meta.sessionStarted ?? (meta.turns > 0 && meta.lastTurn?.ended === true),
            }),
    },
};

/** The cmux pane rung alone: the one pane that demonstrably runs this session, checked against the live tree. */
async function findPane(session: string, edges: DeliveryEdges): Promise<TargetOf<"cmux"> | NoTarget> {
    let result = await edges.findTargets(session, {});

    if (result.unavailable) {
        return { kind: "none", reason: "cmux is not running" };
    }

    let snapshot = result.snapshot;
    let stale = false;

    if (result.targets.length > 0 && result.source === "recorded") {
        snapshot = snapshot ?? (await fetchCmuxLiveSnapshot({ previews: "none", allWindows: true }));

        if (!result.targets.some((target) => isLive(target, snapshot))) {
            stale = true;
            result = await edges.findTargets(session, { skipRecorded: true });
            snapshot = result.snapshot ?? snapshot;
        }
    }

    if (result.targets.length === 0) {
        return {
            kind: "none",
            reason: stale ? "the cmux workspace of this session was closed" : "no cmux pane runs this session",
        };
    }

    // Judge the evidence each pane matched on, not only the stage: a screen-printed id or a shared
    // topic title also comes back from the title and capture stages (resolve.ts identifiesExactSession).
    if (!identifiesExactSession(result) || !isUnambiguous(result.targets)) {
        const several = !SOFT_SOURCES.has(result.source) && !isUnambiguous(result.targets);
        return {
            kind: "none",
            reason: several
                ? `${result.targets.length} cmux panes match this session; none was picked`
                : "the cmux match does not identify the exact recipient session",
        };
    }

    const target = result.targets[0];

    if (!target || !isLive(target, snapshot)) {
        return { kind: "none", reason: "the cmux workspace of this session was closed" };
    }

    return named(target, snapshot);
}

/**
 * The last rung: free text typed into the session's cmux pane as one bracketed paste (JSON, paths and paragraph
 * boundaries survive). It is the only rung a dialog can swallow, so it asks the dialog guard first.
 *
 * The typing runs in a `tools claude cmux send --exact-session` child, not in this process
 * (`sendToSessionPane` in `@app/claude/lib/cmux/pane-send`). The widget must spawn it anyway (the widget-tools
 * identity and its abort signal), and both doors share the one `runTool` transport and one receipt
 * (`readPaneReceipt`). The child also resolves the pane against the live cmux and asks the dialog guard again
 * right before it types, so a pane or dialog that changed since `findPane` stops it, and a caller whose pane lookup
 * is scripted can never type into a real surface.
 */
const paneRoute = {
    async find({ session }: RouteQuery, edges: DeliveryEdges): Promise<RouteHit | NoTarget> {
        const target = await findPane(session, edges);
        return target.kind === "none" ? target : { target, send: (message) => typeIntoPane(target, message, edges) };
    },
};

async function typeIntoPane(
    target: TargetOf<"cmux">,
    { session, sourceHome, text, harness, force }: RouteMessage,
    edges: DeliveryEdges
): Promise<SendOutcome> {
    if (!force && harness) {
        const dialog = await edges.openDialog({ provider: harness, sessionId: session, sourceHome });

        if (dialog) {
            log.warn({ session, provider: harness, dialog }, "a dialog is open in the session; the text is not typed");
            return { kind: "refused", reason: dialogRefusal(dialog) };
        }
    }

    // After `--`: a message that starts with a hyphen is text, not an option. Without force the send asks the same
    // dialog guard again right before it types, so a dialog that opened since the check above still stops it.
    const sent = await edges.runTool(
        [
            "claude",
            "cmux",
            "send",
            "--json",
            "--paste",
            "--exact-session",
            ...(force ? ["--force"] : []),
            // The child's dialog guard asks this harness only, instead of resolving the transcript to find it again.
            ...(harness ? ["--harness", harness] : []),
            "--",
            session,
            text,
        ],
        { timeoutMs: SEND_TIMEOUT_MS }
    );
    const receipt = readPaneReceipt(sent.stdout);
    log.info(
        { session, provider: harness, ok: sent.success, receipt, stderr: sent.stderr.slice(0, 400) },
        "decision answers typed into the cmux pane"
    );

    if (sent.success && receipt.kind === "typed") {
        return {
            kind: "delivered",
            channel: "cmux",
            target: receipt.pane ? cmuxLabel(receipt.pane.workspaceName, receipt.pane.paneTitle) : target.label,
        };
    }

    // A send that ran past its deadline may have typed the text with Enter still owed: never queue it again.
    if (receipt.kind === "unconfirmed" && receipt.timedOut) {
        return {
            kind: "unknown",
            reason: "The cmux send ran past its deadline; the text may be typed without Enter. Check the session before retrying.",
        };
    }

    // A text send never presses a dialog key, so any other `unconfirmed` receipt is no answer this send can trust.
    if (receipt.kind === "unconfirmed") {
        return {
            kind: "unknown",
            reason: receipt.reason ?? "The pane send is unconfirmed. Check the session before retrying.",
        };
    }

    // A readable `sent: false` is a refusal before any input, so the durable session queue may take it.
    // Unreadable output leaves the outcome unknown, and that stays a plain queued result.
    const reason = missSentence(receipt, sent.stderr);
    return receipt.kind === "refused"
        ? { kind: "refused", reason, raw: sent.stderr.trim() }
        : { kind: "failed", reason, raw: sent.stderr.trim() };
}

/**
 * The live place a session's answers can go, decided BEFORE anything is typed. A recorded pane
 * ref is checked against the panes that exist now: the ref outlives a closed workspace, and typing
 * into it failed with a JSON dump. Several weak matches are `none`, since typing into the wrong
 * agent is worse than not typing.
 */
export async function resolveDeliveryTarget(
    { session, provider, sourceHome }: { session: string; provider?: string; sourceHome?: string },
    deps: DeliverDeps = {}
): Promise<DeliveryTarget> {
    const edges = edgesOf(deps);
    const harness = nativeHarness(provider);

    for (const route of harness ? ANSWER_ROUTES[harness].routes : []) {
        const found = await route.find({ session, sourceHome }, edges);
        if (found) {
            return isHit(found) ? found.target : found;
        }
    }

    const pane = await paneRoute.find({ session }, edges);
    return isHit(pane) ? pane.target : pane;
}

/**
 * Tries the session's harness routes in order, then the cmux pane, then the durable session queue. Claude/Grok
 * receipts require a completed same-session turn; Codex requires a provider input acknowledgement. With a source
 * home and stable delivery key, a proven pre-input refusal persists a portable queue entry. An attempted transport
 * with no valid acknowledgement is unknown and must not be resent.
 */
export async function deliverToSession(
    {
        session,
        provider,
        sourceHome,
        text,
        deliveryKey,
        force = false,
    }: {
        session: string;
        provider?: string;
        sourceHome?: string;
        text: string;
        deliveryKey?: string;
        /** Type into the pane even while a dialog is open there. The structural rungs never need it. */
        force?: boolean;
    },
    deps: DeliverDeps = {}
): Promise<DeliveryResult> {
    const edges = edgesOf(deps);
    const harness = nativeHarness(provider);
    const queueTarget: { provider: AccountProviderAlias; sessionId: string; sourceHome: string } | undefined =
        deliveryKey && sourceHome && harness ? { provider: harness, sessionId: session, sourceHome } : undefined;
    const undelivered = async (reason: string): Promise<DeliveryResult> => {
        if (queueTarget && deliveryKey) {
            try {
                const queued = await enqueueSessionMessage({
                    target: queueTarget,
                    text,
                    idempotencyKey: deliveryKey,
                    root: deps.queueRoot,
                });
                return {
                    channel: "queued",
                    delivered: false,
                    queueId: queued.id,
                    queueTextHash: sessionMessageTextHash(queued.text),
                    error: `${reason} Saved for this exact session; awaiting a consumer acknowledgement.`,
                };
            } catch (error) {
                if (!(error instanceof SessionMessageTooLargeError)) {
                    throw error;
                }

                log.warn(
                    { session, bytes: error.bytes, limit: MAX_SESSION_MESSAGE_BYTES },
                    "message too large to queue"
                );
                return {
                    channel: "queued",
                    delivered: false,
                    error: `${reason.replace(/\.$/, "")}. This message is too large to save for later (${error.bytes} bytes, limit ${MAX_SESSION_MESSAGE_BYTES}). Nothing was sent.`,
                };
            }
        }
        return { channel: "queued", delivered: false, error: reason };
    };

    // A retry of a key that an earlier attempt already saved is that same delivery. The process can exit after
    // the save and before its receipt is recorded; sending live as well would deliver the message twice.
    if (
        queueTarget &&
        deliveryKey &&
        findKeyedSessionMessage({ target: queueTarget, root: deps.queueRoot, idempotencyKey: deliveryKey })
    ) {
        return undelivered("An earlier attempt already saved this message for this exact session.");
    }

    const message: RouteMessage = { session, sourceHome, text, harness, force };

    for (const route of [...(harness ? ANSWER_ROUTES[harness].routes : []), paneRoute]) {
        const found = await route.find(message, edges);
        if (!found) {
            continue;
        }

        if (!isHit(found)) {
            log.info({ session, provider, reason: found.reason }, "no live target; the answers stay queued");
            return undelivered(found.reason);
        }

        const outcome = await found.send(message);
        switch (outcome.kind) {
            case "delivered":
                return { channel: outcome.channel, delivered: true, target: outcome.target };
            case "refused":
                return {
                    ...(await undelivered(outcome.reason)),
                    ...(outcome.raw === undefined ? {} : { raw: outcome.raw }),
                };
            case "unknown":
                throw new DeliveryUnknownError(outcome.reason);
            case "failed":
                return { channel: "queued", delivered: false, error: outcome.reason, raw: outcome.raw };
            case "absent":
                log.info(
                    { session, reason: outcome.reason },
                    `the ${found.target.kind} route does not hold the session; trying the next`
                );
                continue;
            default:
                return outcome satisfies never;
        }
    }

    // The pane route always finds a pane or says why there is none, so the ladder ends above.
    return undelivered("no cmux pane runs this session");
}

/** Why `cmux send --json` typed nothing, in one sentence: no pane, several panes, a closed workspace. */
export function paneMiss(stdout: string, stderr = ""): string {
    return missSentence(readPaneReceipt(stdout), stderr);
}

function missSentence(receipt: PaneReceipt, stderr: string): string {
    const known = deliverySentence(stderr);

    if (known) {
        return known;
    }

    if (receipt.kind !== "refused") {
        return "the cmux send failed";
    }

    // The send's dialog guard refused before any keystroke and said why.
    if (receipt.dialog && receipt.reason) {
        return receipt.reason;
    }

    if (receipt.matches !== undefined) {
        return receipt.matches === 0
            ? "no cmux pane runs this session"
            : `${receipt.matches} cmux panes match this session; none was picked`;
    }

    return "the cmux send failed";
}
