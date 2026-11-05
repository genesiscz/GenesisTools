import { logger } from "@genesiscz/utils/logger";
import { backendFor, type FoundPr, type PrBackend, type PublishEvent, type PublishResult, resolvePr } from "./pr";
import {
    claimDraft,
    type DraftDecision,
    decideDraft,
    isProposalProvider,
    isStaleClaim,
    listProposalsFor,
    type ProposalDecision,
    type ProposalDraft,
    ProposalError,
    type ProposalIntentDeps,
    type ProposalProvider,
    type ReconcileResult,
    type ReviewProposal,
    realProposalIntentDeps,
    reconcileProposal,
    recordDraftSent,
    SENT_STATUSES,
} from "./proposal";

// M11, the part the window's Send and Submit buttons did alone: an agent's review proposal goes out from TS. Each
// accepted or edited draft is claimed under the proposal's lock, posted to the PR as a pending review draft outside
// the lock, recorded as `drafted` with the provider's id, and then all pending drafts are published as one review and
// reconciled to `posted`. `hub proposal publish|discard` and the phone's PR triage (F20) call these.

const log = logger.child({ component: "hub/proposal-publish" });

type ProposalRef = Pick<ReviewProposal, "provider" | "host" | "project" | "number">;

/** The review event of the agent's verdict, per forge: GitLab has no request-changes review, so it comments. */
const EVENT_OF_DECISION = {
    github: { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" },
    gitlab: { approve: "APPROVE", request_changes: "COMMENT", comment: "COMMENT" },
} as const satisfies Record<ProposalProvider, Record<ProposalDecision, PublishEvent>>;

export interface ProposalPublishDeps {
    /** The PR named by URL and its backend with the logged-in identity. */
    pr(ref: string): Promise<{ found: FoundPr; backend: PrBackend }>;
    intent: ProposalIntentDeps;
    /** The proposals folder; the real one when omitted. */
    base?: string;
}

export const realProposalPublishDeps: ProposalPublishDeps = {
    pr: async (ref) => {
        const found = await resolvePr({ repo: ".", pr: ref });
        return { found, backend: await backendFor(found) };
    },
    intent: realProposalIntentDeps,
};

export interface DraftSendOutcome {
    draftId: string;
    sent: boolean;
    /** The provider's draft (or reply) id, stored as the draft's `providerId`. */
    providerId?: string;
    error?: string;
}

export interface ProposalPublishResult {
    pr: string;
    /** Each accepted or edited draft this call posted as a pending review draft. */
    drafts: DraftSendOutcome[];
    /** The submitted review; null when a draft failed (nothing is submitted then) or with `publish: false`. */
    published: PublishResult | null;
    reconciled: ReconcileResult | null;
}

function proposalRefOf(found: FoundPr): ProposalRef {
    if (!isProposalProvider(found.provider)) {
        throw new ProposalError(`${found.url} is on ${found.provider}; review proposals live on GitHub or GitLab`);
    }

    return { provider: found.provider, host: found.host, project: found.project, number: found.number };
}

function storedProposal(ref: ProposalRef, base?: string): ReviewProposal {
    const [proposal] = listProposalsFor(ref, base);

    if (!proposal) {
        throw new ProposalError(`no review proposal is stored for ${ref.project}#${ref.number}`);
    }

    return proposal;
}

/**
 * Posts every accepted or edited draft as a pending review draft, then (unless `publish` is false) submits the
 * review with the agent's verdict as the event, or the given one, and reconciles. A draft that fails keeps its
 * decision and claim for reconciliation and stops the submit, since the post may have landed. The window's rule
 * that a proposal goes only to the head it reviewed holds here too.
 */
export async function publishProposal(
    input: { pr: string; event?: PublishEvent; body?: string; publish?: boolean },
    deps: ProposalPublishDeps = realProposalPublishDeps
): Promise<ProposalPublishResult> {
    const { found, backend } = await deps.pr(input.pr);
    const ref = proposalRefOf(found);
    const proposal = storedProposal(ref, deps.base);

    if (found.headSha && proposal.headSha && found.headSha !== proposal.headSha) {
        throw new ProposalError(
            `the proposal reviewed ${proposal.headSha.slice(0, 10)}, but the PR head is now ${found.headSha.slice(0, 10)}; ask the agent for a new review`
        );
    }

    const result: ProposalPublishResult = { pr: found.url, drafts: [], published: null, reconciled: null };

    for (const draft of proposal.drafts) {
        if (draft.status !== "accepted" && draft.status !== "edited") {
            continue;
        }

        const claimed = await claimDraft({ ref, draftId: draft.id, base: deps.base }, deps.intent);

        try {
            const providerId = draft.replyToThread
                ? (await backend.reply({ threadId: draft.replyToThread, body: claimed.body, draft: true })).commentId
                : (
                      await backend.draftAdd({
                          path: draft.path,
                          side: draft.side,
                          line: draft.line,
                          startLine: draft.startLine,
                          body: claimed.body,
                      })
                  ).draftId;
            await recordDraftSent(
                { ref, draftId: draft.id, status: "drafted", providerId, base: deps.base },
                deps.intent
            );
            result.drafts.push({ draftId: draft.id, sent: true, providerId });
        } catch (err) {
            log.warn(
                { err, pr: found.url, draft: draft.id },
                "proposal draft send is uncertain; retained claim for reconciliation"
            );
            result.drafts.push({
                draftId: draft.id,
                sent: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (input.publish === false || result.drafts.some((outcome) => !outcome.sent)) {
        return result;
    }

    const event = input.event ?? EVENT_OF_DECISION[ref.provider][proposal.verdict.decision];
    result.published = await backend.publish({ event, body: input.body });
    result.reconciled = await reconcileProposal(
        { ref, submittedIds: result.published.submittedIds ?? [], base: deps.base },
        deps.intent
    );
    log.info(
        { pr: found.url, event, drafts: result.drafts.length, posted: result.reconciled.posted.length },
        "proposal published"
    );
    return result;
}

/** Rejects every draft nobody sent yet, so the proposal leaves the PR's to-do list; sent drafts stay as they are. */
export async function discardProposal(
    input: { pr: string },
    deps: Pick<ProposalPublishDeps, "pr" | "intent" | "base"> = realProposalPublishDeps
): Promise<{ pr: string; rejected: string[]; busy: string[] }> {
    const { found } = await deps.pr(input.pr);
    const ref = proposalRefOf(found);
    const proposal = storedProposal(ref, deps.base);
    const rejected: string[] = [];
    const busy: string[] = [];

    for (const draft of proposal.drafts) {
        if (SENT_STATUSES.has(draft.status) || draft.status === "rejected") {
            continue;
        }

        if (draft.claim && !isStaleClaim(draft.claim, deps.intent)) {
            busy.push(draft.id);
            continue;
        }

        await decideDraft({ ref, draftId: draft.id, decision: "rejected", base: deps.base }, deps.intent);
        rejected.push(draft.id);
    }

    log.info({ pr: found.url, rejected: rejected.length, busy: busy.length }, "proposal discarded");
    return { pr: found.url, rejected, busy };
}

/** Accepts, edits, rejects or takes back one draft of the PR's proposal. */
export async function decideProposalDraft(
    input: { pr: string; draftId: string; decision: DraftDecision; editedBody?: string },
    deps: Pick<ProposalPublishDeps, "pr" | "intent" | "base"> = realProposalPublishDeps
): Promise<ProposalDraft> {
    const { found } = await deps.pr(input.pr);
    return decideDraft(
        {
            ref: proposalRefOf(found),
            draftId: input.draftId,
            decision: input.decision,
            editedBody: input.editedBody,
            base: deps.base,
        },
        deps.intent
    );
}
