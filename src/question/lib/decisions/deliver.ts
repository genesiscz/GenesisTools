import { type FocusTarget, isUnambiguous } from "@app/claude/lib/cmux/focus";
import { findSessionTargets, type SessionTargetsResult, SOFT_SOURCES } from "@app/claude/lib/cmux/resolve";
import { CodexSessionStore } from "@app/codex/lib/store";
import { execTool } from "@genesiscz/utils/cli";
import { type CmuxLiveSnapshot, fetchCmuxLiveSnapshot } from "@genesiscz/utils/cmux/lib/live-snapshot";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { deliverySentence } from "./delivery-text";

const { log } = logger.scoped("question-deliver");

/**
 * How the answers reach the agent: typed into its cmux pane, steered into its Codex worker, sent
 * as the first prompt of a resumed session, or left for its next prompt.
 */
export type DeliveryChannel = "cmux" | "codex" | "resume" | "queued";

export interface DeliveryResult {
    channel: DeliveryChannel;
    delivered: boolean;
    /** A short human place the answers went: `cmux · agents-window · pane 1`, `codex worker w1`. */
    target?: string;
    /** One sentence saying why nothing was delivered, for the user. */
    error?: string;
    /** The tool's raw output behind the sentence; logged, shown behind a disclosure, never stored. */
    raw?: string;
}

export interface ToolRun {
    success: boolean;
    stdout: string;
    stderr: string;
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
    | { kind: "none"; reason: string };

export interface DeliverDeps {
    /** Runs `tools <args>`; tests replace it with a spy. */
    runTool?: (args: string[]) => Promise<ToolRun>;
    /** The `tools codex` worker name that runs this Codex thread, or null. */
    codexWorkerFor?: (sessionId: string) => string | null;
    /** The cmux panes a session runs in; tests pass a fake. */
    findTargets?: (sessionId: string, opts: { skipRecorded?: boolean }) => Promise<SessionTargetsResult>;
    /** The panes that exist right now, to check a recorded ref against. */
    snapshot?: () => Promise<CmuxLiveSnapshot>;
}

/** A delivery that did not reach the agent. The send puts the batch back to `answered`. */
export class NotDeliveredError extends Error {
    constructor(readonly result: DeliveryResult) {
        super(`not delivered (${result.channel}): ${result.error ?? "no route"}`);
        this.name = "NotDeliveredError";
    }
}

function codexWorkerFor(sessionId: string): string | null {
    const store = new CodexSessionStore();

    for (const name of store.listNames()) {
        const meta = store.readMeta(name);

        if (!meta || meta.status === "closed" || meta.status === "failed") {
            continue;
        }

        if (meta.threadId === sessionId || meta.name === sessionId) {
            return name;
        }
    }

    return null;
}

async function runTool(args: string[]): Promise<ToolRun> {
    return execTool(args, { timeout: 60_000 });
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
    { session, provider }: { session: string; provider?: string },
    deps: DeliverDeps = {}
): Promise<DeliveryTarget> {
    if (provider === "codex") {
        const worker = (deps.codexWorkerFor ?? codexWorkerFor)(session);
        return worker
            ? { kind: "codex", label: `codex worker ${worker}`, worker }
            : { kind: "none", reason: "no live tools codex worker runs this thread" };
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

    if ((SOFT_SOURCES.has(result.source) && result.targets.length > 1) || !isUnambiguous(result.targets)) {
        return { kind: "none", reason: `${result.targets.length} cmux panes match this session; none was picked` };
    }

    const target = result.targets[0];

    if (!target || !isLive(target, snapshot)) {
        return { kind: "none", reason: "the cmux workspace of this session was closed" };
    }

    return named(target, snapshot);
}

/**
 * A pane receives ONE line: a newline typed into a TUI prompt may submit the first answer on its
 * own. The lines are joined with " ; ", which reads the same to the agent.
 */
export function paneText(text: string): string {
    return text.split("\n").join(" ; ");
}

/**
 * Delivers composed decision text to one session. The target is resolved first
 * (`resolveDeliveryTarget`); nothing is typed when it is `none`. Codex sessions driven by
 * `tools codex` are steered; every other provider (Claude, Grok) gets the text typed into its
 * cmux pane through `tools claude cmux send`. When no route works the result is `queued` with one
 * sentence: the answers stay `answered`, and the session's next prompt pulls them through the
 * UserPromptSubmit hook when that is enabled.
 */
export async function deliverToSession(
    { session, provider, text }: { session: string; provider?: string; text: string },
    deps: DeliverDeps = {}
): Promise<DeliveryResult> {
    const run = deps.runTool ?? runTool;
    const target = await resolveDeliveryTarget({ session, provider }, deps);

    if (target.kind === "none") {
        log.info({ session, provider, reason: target.reason }, "no live target; the answers stay queued");
        return { channel: "queued", delivered: false, error: target.reason };
    }

    if (target.kind === "codex") {
        const steered = await run(["codex", "steer", "--name", target.worker, "--prompt", text]);
        log.info({ session, worker: target.worker, ok: steered.success }, "decision answers steered into codex");

        return steered.success
            ? { channel: "codex", delivered: true, target: target.label }
            : {
                  channel: "queued",
                  delivered: false,
                  error: `the codex worker ${target.worker} did not take the answers`,
                  raw: steered.stderr || steered.stdout,
              };
    }

    const sent = await run(["claude", "cmux", "send", session, paneText(text), "--json"]);
    const outcome = parseSent(sent.stdout);
    log.info(
        { session, provider, ok: sent.success, sent: outcome, stderr: sent.stderr.slice(0, 400) },
        "decision answers typed into the cmux pane"
    );

    if (sent.success && outcome.sent) {
        return { channel: "cmux", delivered: true, target: outcome.pane ?? target.label };
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
function parseSent(stdout: string): { sent: boolean; pane?: string } {
    try {
        const parsed = SafeJSON.parse(stdout, { strict: true }) as {
            sent?: unknown;
            target?: { workspaceName?: unknown; paneTitle?: unknown };
        };
        const workspace = typeof parsed.target?.workspaceName === "string" ? parsed.target.workspaceName : "";
        const pane = typeof parsed.target?.paneTitle === "string" ? parsed.target.paneTitle : "";
        return {
            sent: parsed.sent === true,
            ...(workspace || pane ? { pane: cmuxLabel(workspace, pane) } : {}),
        };
    } catch (error) {
        log.debug({ error, stdout: stdout.slice(0, 200) }, "cmux send printed no JSON outcome");
        return { sent: false };
    }
}
