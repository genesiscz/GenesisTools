import { sessionOpenDialog, sessionOpenRecords } from "@app/claude/lib/cmux/dialog-guard";
import { describeMatch, type FocusTarget, isUnambiguous, sessionIdsIn } from "@app/claude/lib/cmux/focus";
import {
    findSessionTargets,
    identifiesExactSession,
    type ResolveDeps,
    retryAfterStaleRefs,
    type SessionTargetsResult,
    SOFT_SOURCES,
    tmuxMissHint,
} from "@app/claude/lib/cmux/resolve";
import { dialogRefusal } from "@genesiscz/utils/agents/dialogs/guard";
import { type DialogKeyPress, planDialogKeys } from "@genesiscz/utils/agents/dialogs/keys";
import { type OpenDialog, type OpenQuestion, openQuestionKey } from "@genesiscz/utils/agents/dialogs/types";
import { ACCOUNT_PROVIDER_ALIASES, isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { isCmuxInvalidParams } from "@genesiscz/utils/cmux/lib/command-error";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("claude-cmux-send");

/** What a pane send is asked to do; the CLI flags of `tools claude cmux send`, as commander parses them. */
export interface SendOptions {
    first?: boolean;
    includeSelf?: boolean;
    enter?: boolean;
    paste?: boolean;
    /** Type the text as keystrokes instead of pasting it. Unlike a paste, a typed send does not see a person's draft. */
    type?: boolean;
    exactSession?: boolean;
    /** Type even while a dialog is open in the session; see `openDialogFor` in `@genesiscz/utils/agents/dialogs`. */
    force?: boolean;
    /**
     * Answer the session's open question dialog with this option (a letter, or a 1-based position) by key presses
     * instead of typing text; see `planDialogKeys` in `@genesiscz/utils/agents/dialogs/keys`.
     */
    option?: string;
    expectedDialog?: string;
    enterDelay?: string;
    dryRun?: boolean;
    json?: boolean;
    /** Seconds. The whole send (lookup, text, Enter) must finish within it. */
    timeout?: string;
    /** The session's harness, when the caller knows it: the dialog guard asks that harness only. */
    harness?: string;
}

export interface SendCommandDeps extends ResolveDeps {
    /** Is a dialog open in this session? Asked before any text is typed; defaults to `sessionOpenDialog`. */
    openDialog?: (sessionId: string) => Promise<OpenDialog | null>;
    /** The session's open dialog records, newest first; defaults to `sessionOpenRecords`. */
    openRecords?: (sessionId: string) => OpenQuestion[];
}

/**
 * What one pane send came to: typed, refused by an open dialog, refused as ambiguous, or not sent (no pane, no live
 * surface, a dry run, an option refused or pressed without confirmation, cmux unreachable). The CLI door prints it;
 * `paneSendReceipt` is its `--json` shape, and `readPaneReceipt` reads that shape back.
 */
export type PaneSendOutcome =
    | { kind: "typed"; query: string; target: FocusTarget; surfaceId: string; enter: boolean; source: string }
    | { kind: "dialog"; query: string; reason: string; dialog: OpenDialog; sessionId: string; target: FocusTarget }
    | {
          kind: "ambiguous";
          query: string;
          matches: FocusTarget[];
          /** The match is weak (a soft source, or not the exact session): its stage and evidence. */
          weak?: { source: string; evidence: string };
      }
    | { kind: "hidden"; query: string; source: string; matches: FocusTarget[]; hidden: FocusTarget }
    | { kind: "no-match"; query: string; tmuxHosts?: SessionTargetsResult["tmuxHosts"]; tmuxHint?: string }
    | { kind: "no-surface"; query: string; matches: FocusTarget[] }
    | { kind: "dry-run"; query: string; target: FocusTarget; surfaceId?: string; plan: Record<string, unknown> }
    | { kind: "option-refused"; query: string; sessionId?: string; reason: string; option?: string }
    | {
          kind: "option-pressed";
          query: string;
          option: string;
          index: number;
          label: string;
          dialog: string;
          presses: readonly DialogKeyPress[];
          target: FocusTarget;
          surfaceId: string;
          source: string;
      }
    | { kind: "unavailable"; reason: string };

/**
 * The surface the text must go to. A title/alias/recorded match names its tab
 * already; a pane-scope match does not, so fall back to the pane's selected
 * tab — `cmux send` without a surface only works inside cmux ($CMUX_SURFACE_ID).
 */
export function deliverySurfaceId(
    target: FocusTarget,
    panes: { id: string; selectedSurfaceRef?: string; surfaces: { id: string; selected: boolean }[] }[]
): string | undefined {
    if (target.surfaceId) {
        return target.surfaceId;
    }

    const pane = panes.find((candidate) => candidate.id === target.paneId);

    return pane?.selectedSurfaceRef ?? pane?.surfaces.find((candidate) => candidate.selected)?.id;
}

interface Delivery {
    target: FocusTarget;
    surfaceId: string;
    text: string;
    enter: boolean;
    enterDelayMs: number;
    paste: boolean;
    /** `--force`: cmux paste also types over a draft or into a dialog it sees on screen. */
    force: boolean;
}

async function deliver({ target, surfaceId, text, enter, enterDelayMs, paste, force }: Delivery) {
    const where = surfaceTargetArgs(surfaceId, target.workspaceId);
    if (paste) {
        await runCmuxOk(["paste", ...where, ...(enter ? ["--submit"] : []), ...(force ? ["--force"] : []), "--", text]);
        return;
    }

    await runCmuxOk(["send", ...where, "--", text]);

    if (enter) {
        await Bun.sleep(enterDelayMs);
        await runCmuxOk(["send-key", ...where, "enter"]);
    }
}

/**
 * The no-wrong-pane guard, shared by the first pass and the stale-ref fallback: the refusal, or undefined when the
 * match may be typed into.
 *
 * A soft match only proves "a pane in that repo" or "a pane that mentions this
 * id", so with several candidates `--first` would type into whichever sorted
 * highest. Typing into the wrong agent session is worse than not typing at all.
 */
export function ambiguousMatch(
    result: SessionTargetsResult,
    query: string,
    opts: SendOptions
): Extract<PaneSendOutcome, { kind: "ambiguous" | "hidden" }> | undefined {
    const hidden = result.targets[0]?.matchedOn === "tmux-hidden" ? result.targets[0] : null;

    // The cmux surface shows the tmux session's current pane, and the session runs in another one: what is typed
    // or read there belongs to that other pane.
    if (hidden) {
        return { kind: "hidden", query, source: result.source, matches: result.targets, hidden };
    }

    // `--exact-session` checks the evidence each pane matched on, not only the stage that found it:
    // a title or capture stage also returns panes that merely print the id or share a topic title.
    const weak = SOFT_SOURCES.has(result.source) && result.targets.length > 1;
    if (weak || (opts.exactSession && !identifiesExactSession(result))) {
        const evidence = result.targets[0] ? describeMatch(result.targets[0]) : result.source;
        return { kind: "ambiguous", query, matches: result.targets, weak: { source: result.source, evidence } };
    }

    if (!isUnambiguous(result.targets) && !opts.first) {
        return { kind: "ambiguous", query, matches: result.targets };
    }

    return undefined;
}

/**
 * The send stops before any keystroke while the session shows a question, plan or permission dialog: typed text
 * plus Enter would pick or deny an option the user never chose, or land in the dialog's free-text field (handoff
 * h_ppczhri1). The session is the full id the query names, else the one the matched pane runs. `--force` types
 * anyway.
 */
async function openDialogRefusal({
    target,
    query,
    opts,
    deps,
    continuedTo,
}: {
    target: FocusTarget;
    query: string;
    opts: SendOptions;
    deps: SendCommandDeps;
    continuedTo?: string;
}): Promise<Extract<PaneSendOutcome, { kind: "dialog" }> | undefined> {
    if (opts.force) {
        return undefined;
    }

    const sessionId = continuedTo ?? sessionIdsIn(query)[0] ?? target.sessionIds[0];

    if (!sessionId) {
        log.debug({ query, paneId: target.paneId }, "the pane names no session; the dialog guard has nothing to ask");
        return undefined;
    }

    const provider = opts.harness && isAccountProviderAlias(opts.harness) ? opts.harness : undefined;
    const dialog = await (deps.openDialog ?? ((id: string) => sessionOpenDialog({ sessionId: id, provider })))(
        sessionId
    );

    if (!dialog) {
        return undefined;
    }

    log.warn({ sessionId, dialog, paneId: target.paneId }, "a dialog is open in the session; nothing was typed");
    return { kind: "dialog", query, reason: dialogRefusal(dialog), dialog, sessionId, target };
}

/** The option path's refusal: nothing was pressed. */
function optionRefusal({
    query,
    sessionId,
    reason,
    opts,
}: {
    query: string;
    sessionId?: string;
    reason: string;
    opts: SendOptions;
}): PaneSendOutcome {
    log.warn({ query, sessionId, option: opts.option, reason }, "send --option refused; no key was pressed");
    return { kind: "option-refused", query, sessionId, reason, option: opts.option };
}

async function press(where: string[], presses: readonly DialogKeyPress[]): Promise<void> {
    for (const key of presses) {
        // `--force`: the dialog is the target here, so cmux's own draft and dialog check must not stop the press.
        if ("key" in key) {
            await runCmuxOk(["send-key", ...where, "--force", key.key]);
        } else {
            await runCmuxOk(["send", ...where, "--force", "--", key.text]);
        }
    }
}

/**
 * `--option`: answer the session's open question dialog by its option key, never by free text (handoff h_bgj1m68y
 * t7). The newest open dialog record of the session names the options; the harness key map (`planDialogKeys`) turns
 * the letter into presses. Refuses with no open record, a record without options, an option past the list, or a
 * harness whose keys are unknown. A key write cannot prove submission, so the record stays open until acknowledgement.
 */
async function pressDialogOption({
    target,
    surfaceId,
    query,
    opts,
    deps,
    source,
    continuedTo,
}: {
    target: FocusTarget;
    surfaceId: string;
    query: string;
    opts: SendOptions & { option: string };
    deps: SendCommandDeps;
    source: string;
    /** The live id when the queried session continued in another one; an option press then refuses. */
    continuedTo?: string;
}): Promise<PaneSendOutcome> {
    const asked = sessionIdsIn(query)[0];

    // The pane runs the successor, so the old session's options would land in another dialog, and the successor's
    // options answer a question the caller never saw. A dialog answer never follows a continuation.
    if (continuedTo && continuedTo !== asked) {
        return optionRefusal({
            query,
            sessionId: continuedTo,
            reason: `the session continued in ${continuedTo}; answer that session's own dialog by its id`,
            opts,
        });
    }

    const sessionId = asked ?? target.sessionIds[0];

    if (!sessionId) {
        return optionRefusal({
            query,
            reason: "the matched pane names no session, so no dialog record can be read",
            opts,
        });
    }

    const [record] = (deps.openRecords ?? sessionOpenRecords)(sessionId);

    if (!record) {
        return optionRefusal({
            query,
            sessionId,
            reason: "no question dialog is open in the session; send the answer as text instead",
            opts,
        });
    }

    if (opts.expectedDialog !== undefined && openQuestionKey(record) !== opts.expectedDialog) {
        return optionRefusal({ query, sessionId, reason: "the open dialog changed; nothing was pressed", opts });
    }

    const plan = planDialogKeys(record, opts.option);

    if (!plan.ok) {
        return optionRefusal({ query, sessionId, reason: plan.reason, opts });
    }

    await press(surfaceTargetArgs(surfaceId, target.workspaceId), plan.presses);
    const dialog = openQuestionKey(record);
    log.info({ sessionId, dialog, index: plan.index, presses: plan.presses, surfaceId }, "dialog option pressed");
    return {
        kind: "option-pressed",
        query,
        option: opts.option,
        index: plan.index,
        label: plan.label,
        dialog,
        presses: plan.presses,
        target,
        surfaceId,
        source,
    };
}

/**
 * Types text into the pane a session is running in, then presses Enter, or presses an option of its open dialog.
 * It prints nothing and never exits: the outcome says what happened, and the CLI door prints it.
 *
 * Resolution is staged (hook journal → tab titles → pane captures); recorded
 * refs that went stale (cmux restarted) fail fast and fall back to the matcher.
 */
export async function sendToSessionPane(
    query: string,
    text: string,
    opts: SendOptions,
    deps: SendCommandDeps = {}
): Promise<PaneSendOutcome> {
    const queryTrim = query.trim();
    const option = opts.option?.trim();

    if (option !== undefined && text.trim()) {
        throw new Error("--option answers the open dialog by key presses only; leave out the text");
    }

    if (option === undefined && !text) {
        throw new Error("give the text to send, or --option <letter> to answer the session's open dialog");
    }

    const enter = opts.enter !== false;
    const enterDelayMs = Number(opts.enterDelay ?? "500");

    if (!Number.isFinite(enterDelayMs) || enterDelayMs < 0) {
        throw new Error(`--enter-delay must be a non-negative number (got ${opts.enterDelay})`);
    }

    if (opts.harness !== undefined && !isAccountProviderAlias(opts.harness)) {
        throw new Error(`--harness is one of ${ACCOUNT_PROVIDER_ALIASES.join(", ")} (got ${opts.harness})`);
    }

    // An option press never takes the recorded pane: it names where the queried id ran, and after a continuation that
    // pane runs the successor, whose dialog the old id's options would answer. The matcher follows the continuation
    // (and refuses below) or finds the pane by the id it runs now.
    let result = await findSessionTargets(queryTrim, {
        includeSelf: opts.includeSelf,
        skipRecorded: option !== undefined,
        deps,
    });

    if (result.unavailable) {
        return { kind: "unavailable", reason: result.unavailable };
    }

    if (result.targets.length === 0) {
        const tmuxHint = tmuxMissHint(result);
        return {
            kind: "no-match",
            query: queryTrim,
            ...(result.tmuxHosts?.length ? { tmuxHosts: result.tmuxHosts } : {}),
            ...(tmuxHint ? { tmuxHint } : {}),
        };
    }

    const refused = ambiguousMatch(result, queryTrim, opts);

    if (refused) {
        return refused;
    }

    let target = result.targets[0];
    let surfaceId = deliverySurfaceId(target, result.snapshot?.panes ?? []);

    if (opts.dryRun) {
        return {
            kind: "dry-run",
            query: queryTrim,
            target,
            surfaceId,
            plan: {
                query: queryTrim,
                wouldSendTo: target,
                surfaceId,
                ...(option !== undefined ? { option } : { text, enter }),
                source: result.source,
            },
        };
    }

    if (option !== undefined) {
        if (!surfaceId) {
            return optionRefusal({
                query: queryTrim,
                reason: "the matched pane has no live surface to press keys in",
                opts,
            });
        }

        return pressDialogOption({
            target,
            surfaceId,
            query: queryTrim,
            opts: { ...opts, option },
            deps,
            source: result.source,
            continuedTo: result.continuedTo,
        });
    }

    // A message goes as one paste. `cmux paste` refuses while a person is typing in that prompt or a dialog is open,
    // while typed keystrokes land in the middle of the person's draft: an agent's message was typed into an unsent
    // prompt that way on 2026-11-01. A paste also keeps the text literal, where `cmux send` reads `\n`, `\r` and `\t`
    // in it as Enter and Tab. Only a slash command, or --type, keeps the typed path, so the prompt sees keystrokes;
    // text with a newline or a backslash is pasted even then.
    const typed = opts.type === true || (opts.paste !== true && text.trimStart().startsWith("/"));
    const paste = !typed || /[\n\r\\]/.test(text);
    const force = opts.force === true;

    if (surfaceId) {
        const dialog = await openDialogRefusal({
            target,
            query: queryTrim,
            opts,
            deps,
            continuedTo: result.continuedTo,
        });

        if (dialog) {
            return dialog;
        }

        try {
            await deliver({ target, surfaceId, text, enter, enterDelayMs, paste, force });
            return { kind: "typed", query: queryTrim, target, surfaceId, enter, source: result.source };
        } catch (err) {
            // cmux answers `invalid_params` before it touches the pane, so such a paste sent nothing and is safe to
            // retry. Any other failed paste may have landed and is never sent twice. The code comes from cmux's own
            // answer: the error message also prints the pasted text, which can say `invalid_params` itself.
            const refused = isCmuxInvalidParams(err);

            if (result.source !== "recorded" || (paste && !refused)) {
                throw err;
            }
            // Recorded refs outlived their pane (cmux restart). Fall back to the matcher.
            log.debug({ err }, "recorded cmux refs are stale; retrying with the text matcher");
        }
    }

    // The stale-ref fallback re-runs the matcher, so it can land on several
    // panes just like the first pass. `retryAfterStaleRefs` is what makes the
    // guard unskippable: without it this typed into targets[0] with no --first,
    // which is the exact case the guard exists to prevent.
    let retryRefusal: PaneSendOutcome | undefined;
    const retry = await retryAfterStaleRefs(queryTrim, { includeSelf: opts.includeSelf, deps }, async (found) => {
        retryRefusal = ambiguousMatch(found, queryTrim, opts);
        return retryRefusal ? null : found.targets[0];
    });
    result = retry.result;

    if (retry.status === "stopped" && retryRefusal) {
        return retryRefusal;
    }

    const fallback = retry.status === "ok" ? retry.target : undefined;
    const fallbackSurface = fallback ? deliverySurfaceId(fallback, result.snapshot?.panes ?? []) : undefined;

    if (!fallback || !fallbackSurface) {
        return { kind: "no-surface", query: queryTrim, matches: result.targets };
    }

    target = fallback;
    surfaceId = fallbackSurface;
    const dialog = await openDialogRefusal({ target, query: queryTrim, opts, deps, continuedTo: result.continuedTo });

    if (dialog) {
        return dialog;
    }

    await deliver({ target, surfaceId, text, enter, enterDelayMs, paste, force });
    return { kind: "typed", query: queryTrim, target, surfaceId, enter, source: result.source };
}

/** The `--json` receipt of a pane send: what `tools claude cmux send --json` prints, and what `readPaneReceipt` reads. */
export function paneSendReceipt(outcome: PaneSendOutcome): Record<string, unknown> {
    switch (outcome.kind) {
        case "typed":
            return {
                query: outcome.query,
                sent: true,
                target: outcome.target,
                surfaceId: outcome.surfaceId,
                enter: outcome.enter,
                source: outcome.source,
            };
        case "dialog":
            return {
                query: outcome.query,
                sent: false,
                reason: outcome.reason,
                dialog: outcome.dialog,
                sessionId: outcome.sessionId,
                target: outcome.target,
            };
        case "ambiguous":
            return outcome.weak
                ? {
                      query: outcome.query,
                      sent: false,
                      ambiguous: true,
                      source: outcome.weak.source,
                      matches: outcome.matches,
                  }
                : { query: outcome.query, sent: false, ambiguous: true, matches: outcome.matches };
        case "hidden":
            return {
                query: outcome.query,
                sent: false,
                hidden: true,
                source: outcome.source,
                matches: outcome.matches,
            };
        case "no-match":
            return {
                query: outcome.query,
                sent: false,
                matches: [],
                ...(outcome.tmuxHosts ? { tmux: outcome.tmuxHosts } : {}),
            };
        case "no-surface":
            return { query: outcome.query, sent: false, matches: outcome.matches };
        case "dry-run":
            return outcome.plan;
        case "option-refused":
            return {
                query: outcome.query,
                sent: false,
                option: outcome.option,
                reason: outcome.reason,
                sessionId: outcome.sessionId,
            };
        case "option-pressed":
            return {
                query: outcome.query,
                sent: false,
                unconfirmed: true,
                reason: "the option key was sent, but submission is not confirmed; check the dialog before retrying",
                option: outcome.option,
                index: outcome.index,
                label: outcome.label,
                dialog: outcome.dialog,
                presses: outcome.presses,
                target: outcome.target,
                surfaceId: outcome.surfaceId,
                source: outcome.source,
            };
        case "unavailable":
            return { sent: false, unavailable: true, reason: outcome.reason };
        default:
            return outcome satisfies never;
    }
}

/**
 * A spawned pane send's receipt, read back from its `--json` stdout: the one parser every caller of a spawned
 * `tools claude cmux send` uses (decision delivery, the widget's transport, a dialog answer).
 * - `typed`: the text went in; `pane` names the workspace and pane it went to, when the receipt says.
 * - `refused`: nothing was typed or pressed (no pane, several panes, an open dialog, a timeout before typing).
 * - `unconfirmed`: an option key was pressed, but nothing confirms the dialog took it; or the send ran past its
 *   `--timeout` (`timedOut`), so the text may be typed without Enter.
 * - `unreadable`: no JSON receipt with a `sent` answer; nobody can tell what happened.
 */
export type PaneReceipt =
    | { kind: "typed"; pane?: { workspaceName: string; paneTitle: string } }
    | {
          kind: "refused";
          reason?: string;
          /** The send's dialog guard refused before any keystroke. */
          dialog: boolean;
          ambiguous: boolean;
          /** How many panes matched, when the receipt lists them. */
          matches?: number;
      }
    | { kind: "unconfirmed"; reason?: string; timedOut: boolean }
    | { kind: "unreadable" };

export function readPaneReceipt(stdout: string): PaneReceipt {
    let raw: unknown;
    try {
        raw = SafeJSON.parse(stdout, { strict: true });
    } catch (error) {
        log.debug({ error, stdout: stdout.slice(0, 200) }, "cmux send printed no JSON receipt");
        return { kind: "unreadable" };
    }

    if (typeof raw !== "object" || raw === null || !("sent" in raw) || typeof raw.sent !== "boolean") {
        return { kind: "unreadable" };
    }

    const reason = "reason" in raw && typeof raw.reason === "string" && raw.reason.length > 0 ? raw.reason : undefined;

    if (raw.sent) {
        const target = "target" in raw && typeof raw.target === "object" && raw.target !== null ? raw.target : {};
        const workspaceName =
            "workspaceName" in target && typeof target.workspaceName === "string" ? target.workspaceName : "";
        const paneTitle = "paneTitle" in target && typeof target.paneTitle === "string" ? target.paneTitle : "";
        return workspaceName || paneTitle ? { kind: "typed", pane: { workspaceName, paneTitle } } : { kind: "typed" };
    }

    // A timeout receipt without the `unconfirmed` flag (a child from before it) is the same outcome.
    const timedOut = reason === "timeout";
    if (("unconfirmed" in raw && raw.unconfirmed === true) || timedOut) {
        return { kind: "unconfirmed", ...(reason ? { reason } : {}), timedOut };
    }

    return {
        kind: "refused",
        ...(reason ? { reason } : {}),
        dialog: "dialog" in raw && Boolean(raw.dialog),
        ambiguous: "ambiguous" in raw && raw.ambiguous === true,
        ...("matches" in raw && Array.isArray(raw.matches) ? { matches: raw.matches.length } : {}),
    };
}
