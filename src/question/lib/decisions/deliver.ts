import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionOpenDialog } from "@app/claude/lib/cmux/dialog-guard";
import { type FocusTarget, isUnambiguous } from "@app/claude/lib/cmux/focus";
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
import { isTestProcess } from "@genesiscz/utils/test-process";
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

/** What the cmux pane rung alone resolves to. */
type PaneTarget = Extract<DeliveryTarget, { kind: "cmux" | "none" }>;

export interface NativeDeliveryWorker {
    /** A harness whose answer route resumes a session by a worker turn (`ANSWER_ROUTES[provider].workers`). */
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

interface OwnedWorkerMeta {
    name: string;
    sessionId: string;
    turns: number;
    activeTurn?: { ownerPid: number; childPid?: number };
}

/** A harness's owned headless workers; `started` says the worker's session exists to resume. */
function ownedWorkers<Meta extends OwnedWorkerMeta>({
    provider,
    store,
    title,
    sourceHome,
    started,
}: {
    provider: AccountProviderAlias;
    store: WorkerMetaStore<Meta>;
    /** The harness as a sentence names it: `Claude`, `Grok`. */
    title: string;
    sourceHome: (meta: Meta) => string;
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
                    ? `The ${title} worker is busy; the answer remains queued for a later turn.`
                    : `The original ${title} worker session has not started.`,
            },
        ];
    });
}

/** The owned headless workers of a harness that resumes a session by a worker turn; none for Codex, which has its own route. */
function nativeWorkers(provider: AccountProviderAlias): NativeDeliveryWorker[] {
    return ANSWER_ROUTES[provider].workers?.list() ?? [];
}

export interface RunToolOptions {
    /** How long the run may take; a quick send by default. */
    timeoutMs?: number;
}

export interface DeliverDeps {
    /** Runs `tools <args>`; tests replace it with a spy. */
    runTool?: (args: string[], options?: RunToolOptions) => Promise<ToolRun>;
    queueRoot?: string;
    /** The `tools codex` worker name that runs this Codex thread, or null. */
    codexWorkerFor?: (sessionId: string, sourceHome?: string) => string | null;
    nativeWorkers?: (provider: AccountProviderAlias) => NativeDeliveryWorker[];
    claudePeers?: (sourceHome?: string) => ClaudeLiveSession[];
    sendClaudePeer?: typeof sendClaudePeerMessage;
    /** The receiving Claude session's permission class; read from its transcript by default. */
    receiverMode?: (sessionId: string) => Promise<PeerSenderMode | null>;
    peerToken?: typeof readPeerToken;
    /** The cmux panes a session runs in; tests pass a fake. */
    findTargets?: (sessionId: string, opts: { skipRecorded?: boolean }) => Promise<SessionTargetsResult>;
    /** The panes that exist right now, to check a recorded ref against. */
    snapshot?: () => Promise<CmuxLiveSnapshot>;
    /** Is a dialog open in the receiving session? Asked before text is typed into a pane; tests pass a fake. */
    openDialog?: (input: OpenDialogInput) => Promise<OpenDialog | null> | OpenDialog | null;
    /** The Grok leader sockets to ask for a session (its record's, then the default); tests pass a fake. */
    grokLeaderSockets?: (sessionId: string) => string[];
    /** An ACP client on one leader socket; tests pass a fake leader. */
    grokLeaderClient?: (socket: string) => GrokLeaderClient;
}

export interface OpenDialogInput {
    provider: DialogProvider;
    sessionId: string;
    sourceHome?: string;
}

/** State signals only (the hook records, then the transcript's turn state), the same guard `cmux send` asks. */
function defaultOpenDialog(input: OpenDialogInput): Promise<OpenDialog | null> {
    return sessionOpenDialog({ sessionId: input.sessionId, provider: input.provider });
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

/** Every send is quick, except a worker steer, which resumes a whole turn and waits for it. */
const TOOL_TIMEOUT_MS = 60_000;
const WORKER_TURN_TIMEOUT_MS = 15 * 60_000;

async function runTool(args: string[], options?: RunToolOptions): Promise<ToolRun> {
    return execTool(args, { timeout: options?.timeoutMs ?? TOOL_TIMEOUT_MS });
}

/** Writes the answer to a private temp file for a `--prompt-file` steer, and removes it once the run returns. */
async function withPromptFile<T>(text: string, use: (promptFile: string) => Promise<T>): Promise<T> {
    const directory = mkdtempSync(join(tmpdir(), "worker-delivery-"));
    try {
        const promptFile = join(directory, "prompt.txt");
        writeFileSync(promptFile, text, { mode: 0o600 });
        return await use(promptFile);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

/**
 * The `--json` receipt of a `tools <harness> steer`. Each field keeps only a value of its type, so one odd field does
 * not hide the others: every branch below compares the fields it needs.
 */
const steerReceiptSchema = z.object({
    kind: z.string().optional().catch(undefined),
    backend: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    completed: z.boolean().optional().catch(undefined),
    exitCode: z.number().optional().catch(undefined),
    sessionId: z.string().optional().catch(undefined),
    sourceHome: z.string().optional().catch(undefined),
    turn: z.number().optional().catch(undefined),
    queued: z.boolean().optional().catch(undefined),
    turnId: z.string().optional().catch(undefined),
});

type SteerReceipt = z.infer<typeof steerReceiptSchema>;

/** A steer's receipt, or null when it is JSON but not an object; output that is not JSON leaves the outcome unknown. */
function readReceipt({
    stdout,
    session,
    unreadable,
}: {
    stdout: string;
    session: string;
    /** The sentence the unknown outcome carries. */
    unreadable: string;
}): SteerReceipt | null {
    let receipt: unknown;
    try {
        receipt = SafeJSON.parse(stdout, { strict: true });
    } catch (error) {
        log.warn({ error, session }, "the steer returned no readable receipt");
        throw new DeliveryUnknownError(unreadable);
    }

    const parsed = steerReceiptSchema.safeParse(receipt);
    return parsed.success ? parsed.data : null;
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

function named(target: FocusTarget, snapshot: CmuxLiveSnapshot | undefined): PaneTarget {
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

/** An owned Claude or Grok worker that runs this session, when one does. */
function ownedWorkerRoute(
    provider: NativeDeliveryWorker["provider"],
    { session, sourceHome }: RouteQuery,
    deps: DeliverDeps
): DeliveryTarget | undefined {
    const owned = (deps.nativeWorkers ?? nativeWorkers)(provider).filter(
        (worker) => worker.provider === provider && worker.sessionId === session
    );
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
    if (worker) {
        return worker.ready
            ? { kind: "worker", label: `${worker.provider} worker ${worker.name}`, worker }
            : { kind: "none", reason: worker.reason ?? "The worker is not ready for another turn." };
    }

    return undefined;
}

/** The live Claude session itself, through its peer socket. */
function claudePeerRoute({ session, sourceHome }: RouteQuery, deps: DeliverDeps): DeliveryTarget | undefined {
    const peers = deps.claudePeers
        ? deps.claudePeers(sourceHome)
        : isTestProcess()
          ? []
          : liveClaudePeers(session, sourceHome);
    const matching = peers.filter((peer) => peer.sessionId === session);
    if (matching.length > 0) {
        const picked = pickClaudePeer(matching);
        if ("reason" in picked) {
            return { kind: "none", reason: picked.reason };
        }

        const { peer, others } = picked;
        if (sourceHome && workerSourceHome(dirname(dirname(peer.file))) !== workerSourceHome(sourceHome)) {
            return { kind: "none", reason: "The native Claude receiver belongs to another source home." };
        }
        const label =
            others > 0
                ? `the Claude terminal active last (pid ${peer.pid}; ${others} older copy idle)`
                : "original Claude session";
        return { kind: "claude-peer", label, peer };
    }

    return undefined;
}

/**
 * The Grok leader the session may run in (`tools cmux agents new grok` records its socket; the default socket is
 * asked too). Only a socket file that exists counts, so a session with no leader falls through to cmux at once.
 */
function grokLeaderRoute({ session }: RouteQuery, deps: DeliverDeps): DeliveryTarget | undefined {
    const sockets = deps.grokLeaderSockets
        ? deps.grokLeaderSockets(session)
        : isTestProcess()
          ? []
          : leaderSocketsFor(session);
    return sockets.length > 0 ? { kind: "grok-leader", label: "Grok leader", sockets } : undefined;
}

/** How the answers of one harness's sessions travel before the cmux pane. */
interface AnswerRoute {
    /** The structured routes, tried before the cmux pane; undefined falls through to cmux. */
    structured(query: RouteQuery, deps: DeliverDeps): Promise<DeliveryTarget | undefined>;
    /**
     * The owned headless workers that resume a session by a worker turn, and the `tools` verb that steers one with the
     * exact session and turn it expects; null for a harness whose worker has a route of its own.
     */
    workers: { list(): NativeDeliveryWorker[]; steer: readonly string[] } | null;
}

/**
 * Each harness's answer route: the drivers' tool-owned `answer` part (each driver names this module), the one table
 * keyed by harness in the delivery code. Codex only through its `tools codex` worker (it is never typed into);
 * Claude through an owned worker, then its own peer socket; Grok through an owned worker, then the leader its TUI
 * runs in.
 */
const ANSWER_ROUTES: { readonly [Id in AccountProviderAlias]: AnswerRoute } = {
    codex: {
        structured: async ({ session, sourceHome }, deps) => {
            const worker = (deps.codexWorkerFor ?? codexWorkerFor)(session, sourceHome);
            return worker
                ? { kind: "codex", label: `codex worker ${worker}`, worker }
                : { kind: "none", reason: `no live ${toolCommand("codex")} worker runs this thread` };
        },
        // `tools codex steer` is the Codex route itself, with its own receipt.
        workers: null,
    },
    claude: {
        structured: async (query, deps) => ownedWorkerRoute("claude", query, deps) ?? claudePeerRoute(query, deps),
        workers: {
            list: () =>
                ownedWorkers({
                    provider: "claude",
                    store: new ClaudeWorkerStore(),
                    title: "Claude",
                    sourceHome: claudeWorkerSourceHome,
                    started: (meta) => meta.turns > 0,
                }),
            steer: ["claude", "worker", "steer"],
        },
    },
    grok: {
        structured: async (query, deps) => ownedWorkerRoute("grok", query, deps) ?? grokLeaderRoute(query, deps),
        workers: {
            list: () =>
                ownedWorkers({
                    provider: "grok",
                    store: new GrokSessionStore(),
                    title: "Grok",
                    sourceHome: (meta) => meta.workerHome,
                    started: (meta) => meta.sessionStarted ?? (meta.turns > 0 && meta.lastTurn?.ended === true),
                }),
            steer: ["grok", "steer"],
        },
    },
};

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
    const harness = nativeHarness(provider);
    const structured = harness ? await ANSWER_ROUTES[harness].structured({ session, sourceHome }, deps) : undefined;

    if (structured) {
        return structured;
    }

    return resolvePaneTarget(session, deps);
}

/** The cmux pane rung alone: the one pane that demonstrably runs this session, checked against the live tree. */
async function resolvePaneTarget(session: string, deps: DeliverDeps): Promise<PaneTarget> {
    const find = deps.findTargets ?? ((id, opts) => findSessionTargets(id, opts));
    const snapshotOf = deps.snapshot ?? (() => fetchCmuxLiveSnapshot({ previews: "none", allWindows: true }));
    let result = await find(session, {});

    if (result.unavailable) {
        return { kind: "none", reason: "cmux is not running" };
    }

    let snapshot = result.snapshot;
    let stale = false;

    if (result.targets.length > 0 && result.source === "recorded") {
        snapshot = snapshot ?? (await snapshotOf());

        if (!result.targets.some((target) => isLive(target, snapshot))) {
            stale = true;
            result = await find(session, { skipRecorded: true });
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

/** The backend a `tools codex steer` receipt names: the Codex route's own worker. */
const CODEX_WORKER_BACKEND: AccountProviderAlias = "codex";

/**
 * Resolve an exact owned worker before the optional cmux route. Claude/Grok receipts require a
 * completed same-session turn; Codex requires a provider input acknowledgement. With a source
 * home and stable delivery key, a proven pre-input refusal persists a portable queue entry.
 * An attempted transport with no valid acknowledgement is unknown and must not be resent.
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
    const run = deps.runTool ?? runTool;
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

    const resolved = await resolveDeliveryTarget({ session, provider, sourceHome }, deps);

    if (resolved.kind === "grok-leader") {
        const sockets = resolved.sockets;
        const sent = await sendToGrokLeader(
            { sessionId: session, text },
            { sockets: () => sockets, ...(deps.grokLeaderClient ? { client: deps.grokLeaderClient } : {}) }
        );

        if (sent.kind === "delivered") {
            // The leader queued the prompt in this exact session; the turn runs there and the TUI renders it.
            return {
                channel: "grok-leader",
                delivered: true,
                target: `Grok leader · session ${sent.sessionId}${sent.promptId ? ` · prompt ${sent.promptId}` : ""}`,
            };
        }

        if (sent.kind === "unknown") {
            throw new DeliveryUnknownError(
                "The Grok leader may have queued the answer without acknowledging it. Check the conversation before retrying."
            );
        }

        log.info({ session, reason: sent.reason }, "no Grok leader took the answer; trying the cmux pane");
    }

    // No leader took a Grok answer: the guarded pane is the next rung.
    const target = resolved.kind === "grok-leader" ? await resolvePaneTarget(session, deps) : resolved;

    if (target.kind === "none") {
        log.info({ session, provider, reason: target.reason }, "no live target; the answers stay queued");
        return undelivered(target.reason);
    }

    if (target.kind === "claude-peer") {
        const current = deps.claudePeers
            ? deps.claudePeers(sourceHome).filter((peer) => peer.sessionId === session)
            : liveClaudePeers(session, sourceHome);
        const again = pickClaudePeer(current);
        if (
            "reason" in again ||
            again.peer.pid !== target.peer.pid ||
            again.peer.socketPath !== target.peer.socketPath ||
            again.peer.file !== target.peer.file
        ) {
            return undelivered("The native Claude receiver changed before delivery; no message was written.");
        }
        const directory = dirname(target.peer.file);
        // A receiver in bypass holds a plain frame for approval, so the answer goes out with a stand-in sender of
        // the same class, as `tools claude message` attests one (DECISION 25 a)). Any other receiver gets the plain
        // frame, as before.
        const receiverMode = await (deps.receiverMode ?? sessionSenderMode)(session);
        const sender = receiverMode === "bypass" ? standInSender("bypass") : null;
        try {
            await (deps.sendClaudePeer ?? sendClaudePeerMessage)({
                session: target.peer,
                text,
                token: (deps.peerToken ?? readPeerToken)(target.peer, directory),
                priority: "next",
                sender,
                timeoutMs: 5_000,
            });
        } catch (error) {
            log.warn({ session, pid: target.peer.pid, error }, "native Claude peer delivery has an unknown outcome");
            throw new DeliveryUnknownError(
                "The native Claude message may have been received. Inspect the conversation before retrying."
            );
        }
        log.info(
            { session, pid: target.peer.pid, receiverMode, attested: sender !== null },
            "native Claude peer message flushed"
        );
        // This confirms a complete transport write, not an agent-processing acknowledgement.
        // DECISION remains sent until the receiving agent records acknowledged/implemented.
        return { channel: "claude-peer", delivered: true, target: target.label };
    }

    if (target.kind === "worker") {
        const { worker } = target;
        const prefix = ANSWER_ROUTES[worker.provider].workers?.steer;

        if (!prefix) {
            return undelivered(`A ${worker.provider} session has no owned worker to steer; no prompt was sent.`);
        }

        const result = await withPromptFile(text, (promptFile) =>
            run(
                [
                    ...prefix,
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
                { timeoutMs: WORKER_TURN_TIMEOUT_MS }
            )
        );
        const receipt = readReceipt({
            stdout: result.stdout,
            session,
            unreadable: "The resumed worker returned no readable receipt. Check its conversation before retrying.",
        });
        if (!receipt) {
            throw new DeliveryUnknownError(
                "The resumed worker returned an invalid receipt. Check its conversation before retrying."
            );
        }

        const sameWorker = receipt.backend === worker.provider && receipt.name === worker.name;
        if (sameWorker && receipt.kind === "rejected" && receipt.error !== undefined) {
            return undelivered(receipt.error);
        }

        if (
            result.success &&
            sameWorker &&
            receipt.kind === "turn" &&
            receipt.completed === true &&
            receipt.exitCode === 0 &&
            receipt.sessionId === worker.sessionId &&
            receipt.sourceHome !== undefined &&
            workerSourceHome(receipt.sourceHome) === workerSourceHome(worker.sourceHome) &&
            receipt.turn === worker.turns + 1
        ) {
            log.info(
                { session, provider, worker: worker.name, turn: receipt.turn },
                "Answer acknowledged by completed same-session worker turn"
            );
            return { channel: "resume", delivered: true, target: `${target.label} · resumed turn ${receipt.turn}` };
        }

        throw new DeliveryUnknownError(
            "The resumed worker did not acknowledge this exact session and turn. Check its conversation before retrying."
        );
    }

    // The routes that returned above leave two: a `tools codex` worker, or the cmux pane below.
    if (target.kind !== "cmux") {
        const steered = await withPromptFile(text, (promptFile) =>
            run([
                "codex",
                "steer",
                "--name",
                target.worker,
                "--json",
                "--prompt-file",
                promptFile,
                ...(sourceHome ? ["--expect-session", session, "--expect-home", sourceHome] : []),
            ])
        );
        log.info({ session, worker: target.worker, ok: steered.success }, "decision answers steered into codex");

        const receipt = readReceipt({
            stdout: steered.stdout,
            session,
            unreadable: "Codex returned no input acknowledgement. Check the conversation before retrying.",
        });
        if (
            receipt?.kind === "rejected" &&
            receipt.backend === CODEX_WORKER_BACKEND &&
            receipt.name === target.worker &&
            receipt.error !== undefined
        ) {
            return undelivered(receipt.error);
        }

        if (steered.success && receipt) {
            if (receipt.queued === false && receipt.turnId) {
                // `steerCodexMessage` reports this receipt as `delivered: false`, because there
                // `delivered` means consumer-acknowledged (run.test.ts). For a Decision answer an
                // acknowledged provider turn is enough to mark the batch sent, so it maps to true here.
                return {
                    channel: "codex",
                    delivered: true,
                    target: `${target.label} · input acknowledged (turn ${receipt.turnId})`,
                };
            }

            if (receipt.queued === true) {
                throw new DeliveryUnknownError(
                    "Codex accepted the message into its daemon queue, but has not acknowledged a provider turn. Do not resend before checking the conversation."
                );
            }
        }

        throw new DeliveryUnknownError(
            "Codex did not return a valid input acknowledgement. Check the conversation before retrying."
        );
    }

    // The last rung types free text into the pane, so it is the only one a dialog can swallow. Structural rungs
    // (the Claude peer socket, an owned worker, the Codex app-server) answered above and never reach this.
    if (!force && harness) {
        const dialog = await (deps.openDialog ?? defaultOpenDialog)({
            provider: harness,
            sessionId: session,
            sourceHome,
        });

        if (dialog) {
            log.warn({ session, provider, dialog }, "a dialog is open in the session; the text is not typed");
            return undelivered(dialogRefusal(dialog));
        }
    }

    // After `--`: a message that starts with a hyphen is text, not an option. Without force the send asks the same
    // dialog guard again right before it types, so a dialog that opened since the check above still stops it.
    const sent = await run([
        "claude",
        "cmux",
        "send",
        "--json",
        "--paste",
        "--exact-session",
        ...(force ? ["--force"] : []),
        "--",
        session,
        // One bracketed paste, so JSON, paths and paragraph breaks arrive as written.
        text,
    ]);
    const outcome = parseSent(sent.stdout);
    log.info(
        { session, provider, ok: sent.success, sent: outcome, stderr: sent.stderr.slice(0, 400) },
        "decision answers typed into the cmux pane"
    );

    if (sent.success && outcome.sent) {
        return { channel: "cmux", delivered: true, target: outcome.pane ?? target.label };
    }

    // A readable `sent: false` is a refusal before any input, so the durable session queue may take it.
    // Unreadable output leaves the outcome unknown, and that stays a plain queued result.
    if (outcome.readable && !outcome.sent) {
        return { ...(await undelivered(paneMiss(sent.stdout, sent.stderr))), raw: sent.stderr.trim() };
    }

    return { channel: "queued", delivered: false, error: paneMiss(sent.stdout, sent.stderr), raw: sent.stderr.trim() };
}

/** Why `cmux send --json` typed nothing, in one sentence: no pane, several panes, a closed workspace. */
export function paneMiss(stdout: string, stderr = ""): string {
    const known = deliverySentence(stderr);

    if (known) {
        return known;
    }

    try {
        const parsed = SafeJSON.parse(stdout, { strict: true }) as {
            matches?: unknown;
            reason?: unknown;
            dialog?: unknown;
        };

        // The send's dialog guard refused before any keystroke and said why.
        if (parsed.dialog && typeof parsed.reason === "string" && parsed.reason.length > 0) {
            return parsed.reason;
        }

        if (Array.isArray(parsed.matches)) {
            return parsed.matches.length === 0
                ? "no cmux pane runs this session"
                : `${parsed.matches.length} cmux panes match this session; none was picked`;
        }
    } catch (error) {
        log.debug({ error, stdout: stdout.slice(0, 200) }, "cmux send printed no JSON outcome");
    }

    return "the cmux send failed";
}

/** `cmux send --json`: whether it typed, and the pane it typed into as `cmux · workspace · pane`. */
function parseSent(stdout: string): { sent: boolean; readable: boolean; pane?: string } {
    try {
        const parsed = SafeJSON.parse(stdout, { strict: true }) as {
            sent?: unknown;
            target?: { workspaceName?: unknown; paneTitle?: unknown };
        };
        const workspace = typeof parsed.target?.workspaceName === "string" ? parsed.target.workspaceName : "";
        const pane = typeof parsed.target?.paneTitle === "string" ? parsed.target.paneTitle : "";
        return {
            sent: parsed.sent === true,
            readable: typeof parsed.sent === "boolean",
            ...(workspace || pane ? { pane: cmuxLabel(workspace, pane) } : {}),
        };
    } catch (error) {
        log.debug({ error, stdout: stdout.slice(0, 200) }, "cmux send printed no JSON outcome");
        return { sent: false, readable: false };
    }
}
