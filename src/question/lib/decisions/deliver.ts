import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type FocusTarget, isUnambiguous } from "@app/claude/lib/cmux/focus";
import {
    findSessionTargets,
    identifiesExactSession,
    type SessionTargetsResult,
    SOFT_SOURCES,
} from "@app/claude/lib/cmux/resolve";
import { ClaudeWorkerStore, claudeWorkerSourceHome } from "@app/claude/lib/worker/store";
import { CodexSessionStore, codexWorkerHome } from "@app/codex/lib/store";
import { GrokSessionStore } from "@app/grok/lib/store";
import {
    enqueueSessionMessage,
    findKeyedSessionMessage,
    sessionMessageTextHash,
} from "@genesiscz/utils/agent-sessions/message-queue";
import {
    type ClaudeLiveSession,
    claudeSessionsDir,
    listClaudeLiveSessions,
    readPeerToken,
    sendClaudePeerMessage,
} from "@genesiscz/utils/claude/peer-message";
import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type CmuxLiveSnapshot, fetchCmuxLiveSnapshot } from "@genesiscz/utils/cmux/lib/live-snapshot";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { batchPsInfo } from "@genesiscz/utils/process/ps";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { isTestProcess } from "@genesiscz/utils/test-process";
import { workerSourceHome } from "@genesiscz/utils/worker/delivery";
import { deliverySentence } from "./delivery-text";

const { log } = logger.scoped("question-deliver");

/**
 * How the answers reach the agent: typed into its cmux pane, steered into its Codex worker, sent
 * as the first prompt of a resumed session, or left for its next prompt.
 */
export type DeliveryChannel = "cmux" | "codex" | "claude-peer" | "resume" | "queued";

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
    const candidates = listClaudeLiveSessions(directory, (pids) => new Set(pids)).filter(
        (peer) => peer.sessionId === session
    );
    const processes = batchPsInfo(candidates.map((peer) => peer.pid));
    return candidates.filter((peer) => {
        const process = processes.get(peer.pid);
        return process && /claude/i.test(process.command);
    });
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
    | { kind: "none"; reason: string };

export interface NativeDeliveryWorker {
    provider: "claude" | "grok";
    name: string;
    sessionId: string;
    sourceHome: string;
    turns: number;
    ready: boolean;
    reason?: string;
}

function nativeWorkers(provider: "claude" | "grok"): NativeDeliveryWorker[] {
    const busy = (active?: { ownerPid: number; childPid?: number }) =>
        Boolean(active && (isProcessAlive(active.ownerPid) || (active.childPid && isProcessAlive(active.childPid))));
    if (provider === "claude") {
        const store = new ClaudeWorkerStore();
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
                    sourceHome: claudeWorkerSourceHome(meta),
                    turns: meta.turns,
                    ready: !running && meta.turns > 0,
                    reason: running
                        ? "The Claude worker is busy; the answer remains queued for a later turn."
                        : "The original Claude worker session has not started.",
                },
            ];
        });
    }
    const store = new GrokSessionStore();
    return store.listNames().flatMap((name) => {
        const meta = store.readMeta(name);
        if (!meta) {
            return [];
        }
        const running = busy(meta.activeTurn);
        const started = meta.sessionStarted ?? (meta.turns > 0 && meta.lastTurn?.ended === true);
        return [
            {
                provider,
                name,
                sessionId: meta.sessionId,
                sourceHome: meta.workerHome,
                turns: meta.turns,
                ready: !running && started,
                reason: running
                    ? "The Grok worker is busy; the answer remains queued for a later turn."
                    : "The original Grok worker session has not started.",
            },
        ];
    });
}

export interface DeliverDeps {
    /** Runs `tools <args>`; tests replace it with a spy. */
    runTool?: (args: string[]) => Promise<ToolRun>;
    queueRoot?: string;
    /** The `tools codex` worker name that runs this Codex thread, or null. */
    codexWorkerFor?: (sessionId: string, sourceHome?: string) => string | null;
    nativeWorkers?: (provider: "claude" | "grok") => NativeDeliveryWorker[];
    claudePeers?: (sourceHome?: string) => ClaudeLiveSession[];
    sendClaudePeer?: typeof sendClaudePeerMessage;
    peerToken?: typeof readPeerToken;
    /** The cmux panes a session runs in; tests pass a fake. */
    findTargets?: (sessionId: string, opts: { skipRecorded?: boolean }) => Promise<SessionTargetsResult>;
    /** The panes that exist right now, to check a recorded ref against. */
    snapshot?: () => Promise<CmuxLiveSnapshot>;
}

/** The transport was attempted but its receipt was lost; never put it back on an automatic send queue. */
export class DeliveryUnknownError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DeliveryUnknownError";
    }
}

/** A delivery that did not reach the agent. The send puts the batch back to `answered`. */
export class NotDeliveredError extends Error {
    constructor(readonly result: DeliveryResult) {
        super(`not delivered (${result.channel}): ${result.error ?? "no route"}`);
        this.name = "NotDeliveredError";
    }
}

function codexWorkerFor(sessionId: string, sourceHome?: string): string | null {
    const store = new CodexSessionStore();

    for (const name of store.listNames()) {
        const meta = store.readMeta(name);

        if (!meta || meta.status === "closed" || meta.status === "failed") {
            continue;
        }

        const sameHome = !sourceHome || workerSourceHome(sourceHome) === workerSourceHome(codexWorkerHome(meta));
        if (meta.threadId === sessionId && sameHome) {
            return name;
        }
    }

    return null;
}

async function runTool(args: string[]): Promise<ToolRun> {
    const resumed = (args[0] === "claude" && args[1] === "worker") || args[0] === "grok";
    return execTool(args, { timeout: resumed ? 15 * 60_000 : 60_000 });
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

function named(target: FocusTarget, snapshot: CmuxLiveSnapshot | undefined): DeliveryTarget {
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
            pane?.selectedSurfaceRef ??
            pane?.surfaces.find((candidate) => candidate.selected)?.id ??
            "",
    };
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
    if (provider === "codex") {
        const worker = (deps.codexWorkerFor ?? codexWorkerFor)(session, sourceHome);
        return worker
            ? { kind: "codex", label: `codex worker ${worker}`, worker }
            : { kind: "none", reason: `no live ${toolCommand("codex")} worker runs this thread` };
    }

    const nativeProvider = provider === "claude-code" ? "claude" : provider;
    if (nativeProvider === "claude" || nativeProvider === "grok") {
        const owned = (deps.nativeWorkers ?? nativeWorkers)(nativeProvider).filter(
            (worker) => worker.provider === nativeProvider && worker.sessionId === session
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
    }

    if (nativeProvider === "claude") {
        const peers = deps.claudePeers
            ? deps.claudePeers(sourceHome)
            : isTestProcess()
              ? []
              : liveClaudePeers(session, sourceHome);
        const matching = peers.filter((peer) => peer.sessionId === session);
        if (matching.length > 1) {
            return { kind: "none", reason: "Several native Claude receivers claim this session; none was picked." };
        }
        const peer = matching[0];
        if (peer) {
            if (sourceHome && workerSourceHome(dirname(dirname(peer.file))) !== workerSourceHome(sourceHome)) {
                return { kind: "none", reason: "The native Claude receiver belongs to another source home." };
            }
            return { kind: "claude-peer", label: "original Claude session", peer };
        }
    }

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

/** Agent replies use one bracketed paste, preserving JSON, paths and paragraph boundaries. */
export function paneText(text: string): string {
    return text;
}

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
    }: { session: string; provider?: string; sourceHome?: string; text: string; deliveryKey?: string },
    deps: DeliverDeps = {}
): Promise<DeliveryResult> {
    const run = deps.runTool ?? runTool;
    const nativeProvider = provider === "claude-code" ? "claude" : provider;
    const queueTarget: { provider: "claude" | "codex" | "grok"; sessionId: string; sourceHome: string } | undefined =
        deliveryKey &&
        sourceHome &&
        (nativeProvider === "claude" || nativeProvider === "codex" || nativeProvider === "grok")
            ? { provider: nativeProvider, sessionId: session, sourceHome }
            : undefined;
    const undelivered = async (reason: string): Promise<DeliveryResult> => {
        if (queueTarget && deliveryKey) {
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

    const target = await resolveDeliveryTarget({ session, provider, sourceHome }, deps);

    if (target.kind === "none") {
        log.info({ session, provider, reason: target.reason }, "no live target; the answers stay queued");
        return undelivered(target.reason);
    }

    if (target.kind === "claude-peer") {
        const current = deps.claudePeers
            ? deps.claudePeers(sourceHome).filter((peer) => peer.sessionId === session)
            : liveClaudePeers(session, sourceHome);
        if (
            current.length !== 1 ||
            current[0].pid !== target.peer.pid ||
            current[0].socketPath !== target.peer.socketPath ||
            current[0].file !== target.peer.file
        ) {
            return undelivered("The native Claude receiver changed before delivery; no message was written.");
        }
        const directory = dirname(target.peer.file);
        try {
            await (deps.sendClaudePeer ?? sendClaudePeerMessage)({
                session: target.peer,
                text,
                token: (deps.peerToken ?? readPeerToken)(target.peer, directory),
                priority: "next",
                timeoutMs: 5_000,
            });
        } catch (error) {
            log.warn({ session, pid: target.peer.pid, error }, "native Claude peer delivery has an unknown outcome");
            throw new DeliveryUnknownError(
                "The native Claude message may have been received. Inspect the conversation before retrying."
            );
        }
        log.info({ session, pid: target.peer.pid }, "native Claude peer message flushed");
        // This confirms a complete transport write, not an agent-processing acknowledgement.
        // DECISION remains sent until the receiving agent records acknowledged/implemented.
        return { channel: "claude-peer", delivered: true, target: target.label };
    }

    if (target.kind === "worker") {
        const { worker } = target;
        const directory = mkdtempSync(join(tmpdir(), "worker-delivery-"));
        const promptFile = join(directory, "prompt.txt");
        try {
            writeFileSync(promptFile, text, { mode: 0o600 });
            const prefix = worker.provider === "claude" ? ["claude", "worker", "steer"] : ["grok", "steer"];
            const result = await run([
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
            ]);
            let receipt: unknown;
            try {
                receipt = SafeJSON.parse(result.stdout, { strict: true });
            } catch (error) {
                log.warn({ error, session, provider }, "Native worker returned no machine receipt");
                throw new DeliveryUnknownError(
                    "The resumed worker returned no readable receipt. Check its conversation before retrying."
                );
            }
            if (typeof receipt !== "object" || receipt === null) {
                throw new DeliveryUnknownError(
                    "The resumed worker returned an invalid receipt. Check its conversation before retrying."
                );
            }
            const value = receipt as Record<string, unknown>;
            const sameWorker = value.backend === worker.provider && value.name === worker.name;
            if (sameWorker && value.kind === "rejected" && typeof value.error === "string") {
                return undelivered(value.error);
            }
            if (
                result.success &&
                sameWorker &&
                value.kind === "turn" &&
                value.completed === true &&
                value.exitCode === 0 &&
                value.sessionId === worker.sessionId &&
                typeof value.sourceHome === "string" &&
                workerSourceHome(value.sourceHome) === workerSourceHome(worker.sourceHome) &&
                value.turn === worker.turns + 1
            ) {
                log.info(
                    { session, provider, worker: worker.name, turn: value.turn },
                    "Answer acknowledged by completed same-session worker turn"
                );
                return { channel: "resume", delivered: true, target: `${target.label} · resumed turn ${value.turn}` };
            }
            throw new DeliveryUnknownError(
                "The resumed worker did not acknowledge this exact session and turn. Check its conversation before retrying."
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }

    if (target.kind === "codex") {
        const directory = mkdtempSync(join(tmpdir(), "worker-delivery-"));
        const promptFile = join(directory, "prompt.txt");
        let steered: ToolRun;
        try {
            writeFileSync(promptFile, text, { mode: 0o600 });
            steered = await run([
                "codex",
                "steer",
                "--name",
                target.worker,
                "--json",
                "--prompt-file",
                promptFile,
                ...(sourceHome ? ["--expect-session", session, "--expect-home", sourceHome] : []),
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
        log.info({ session, worker: target.worker, ok: steered.success }, "decision answers steered into codex");

        let receipt: unknown;
        try {
            receipt = SafeJSON.parse(steered.stdout, { strict: true });
        } catch (error) {
            log.warn({ error, session }, "Codex transport returned no readable acknowledgement");
            throw new DeliveryUnknownError(
                "Codex returned no input acknowledgement. Check the conversation before retrying."
            );
        }
        if (
            typeof receipt === "object" &&
            receipt !== null &&
            "kind" in receipt &&
            receipt.kind === "rejected" &&
            "backend" in receipt &&
            receipt.backend === "codex" &&
            "name" in receipt &&
            receipt.name === target.worker &&
            "error" in receipt &&
            typeof receipt.error === "string"
        ) {
            return undelivered(receipt.error);
        }
        if (steered.success && typeof receipt === "object" && receipt !== null && "queued" in receipt) {
            if (
                receipt.queued === false &&
                "turnId" in receipt &&
                typeof receipt.turnId === "string" &&
                receipt.turnId
            ) {
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

    const sent = await run(["claude", "cmux", "send", session, paneText(text), "--json", "--paste", "--exact-session"]);
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
        const parsed = SafeJSON.parse(stdout, { strict: true }) as { matches?: unknown };

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
