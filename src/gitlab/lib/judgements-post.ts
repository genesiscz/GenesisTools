/**
 * `comments post`: the judgements file's actions as GitLab drafts. Planning is pure (this file); the
 * command runs the plan, dry by default.
 *
 * - `--do T01,D03,N01`: each item's own Action (reply, reply-resolve, delete, reword, move, comment).
 * - `--answers D05,Y02`: the Proposed answer into my own thread; a D item only after `comments publish`
 *   turned its draft into a thread (nobody can reply to an unpublished draft).
 *
 * A ledger keyed by MR and id remembers what landed, so a re-run skips it instead of posting twice.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storage } from "@app/gitlab/lib/config";
import {
    type JudgementItem,
    type Judgements,
    type ParsedAnchor,
    parseAnchor,
    verdictOf,
} from "@app/gitlab/lib/judgements";
import type { KnownItem } from "@app/gitlab/lib/judgements-check";
import { postedText, signedAnswer } from "@app/gitlab/lib/judgements-render";
import type { DraftSummary } from "@app/gitlab/lib/review-drafts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

export type PostStep =
    | { id: string; kind: "reply"; discussionId: string; body: string; resolve: boolean; where: string }
    | { id: string; kind: "delete"; draftId: number; where: string }
    | { id: string; kind: "reword"; draftId: number; body: string; where: string }
    | { id: string; kind: "move"; draftId: number; anchor: ParsedAnchor; body: string; where: string }
    | { id: string; kind: "comment"; anchor: ParsedAnchor; body: string; where: string };

export interface PostPlan {
    steps: PostStep[];
    skipped: Array<{ id: string; reason: string }>;
    errors: Array<{ id: string; message: string }>;
}

export interface PlanInput {
    judgements: Judgements;
    known: KnownItem[];
    /** `--do`: run each item's Action. */
    ids: string[];
    /** `--answers`: post each item's Proposed answer into my own thread. */
    answers: string[];
    agent: string;
}

function anchorWhere(anchor: ParsedAnchor): string {
    return anchor.top ? "top-level" : `${anchor.path}:${anchor.line} (${anchor.side})`;
}

function knownWhere(known: KnownItem): string {
    const at = known.path ? `${known.path}:${known.line ?? 1}` : "top-level";

    return known.pair.kind === "discussion"
        ? `thread ${known.pair.value.slice(0, 8)} at ${at}`
        : `draft ${known.pair.value} at ${at}`;
}

function normalized(ids: string[]): string[] {
    return [...new Set(ids.map((id) => id.trim().toUpperCase()).filter(Boolean))];
}

function stepFor(
    item: JudgementItem,
    known: KnownItem | undefined,
    agent: string
): PostStep | { skip: string } | { error: string } {
    const action = (item.fields.get("Action") ?? "").trim();
    const text = postedText(item, agent);

    if (action === "none" || action === "keep") {
        return { skip: `Action ${action}` };
    }

    if (item.kind === "N") {
        const anchor = parseAnchor(item.fields.get("Anchor") ?? "");

        if (typeof anchor === "string" || !text) {
            return { error: typeof anchor === "string" ? anchor : "nothing to post" };
        }

        return { id: item.id, kind: "comment", anchor, body: text, where: anchorWhere(anchor) };
    }

    if (!known) {
        return { error: "no such item on this MR now; run `review skeleton` again" };
    }

    if (item.kind === "T" || item.kind === "Y") {
        if (!text) {
            return { error: `Action ${action} has no text` };
        }

        return {
            id: item.id,
            kind: "reply",
            discussionId: known.pair.value,
            body: text,
            resolve: action === "reply-resolve",
            where: knownWhere(known),
        };
    }

    if (known.publishedFrom) {
        return { error: `the draft was published; answer in its thread with --answers ${item.id}` };
    }

    const draftId = Number(known.pair.value);

    if (action === "delete") {
        return { id: item.id, kind: "delete", draftId, where: knownWhere(known) };
    }

    const rewording = item.fences.get("Proposed rewording")?.trim();

    if (action === "reword") {
        return rewording
            ? { id: item.id, kind: "reword", draftId, body: rewording, where: knownWhere(known) }
            : { error: "reword has no Proposed rewording" };
    }

    if (action === "move") {
        const anchor = parseAnchor(item.fields.get("Move to") ?? "");

        if (typeof anchor === "string") {
            return { error: anchor };
        }

        return {
            id: item.id,
            kind: "move",
            draftId,
            anchor,
            body: rewording || known.body,
            where: `${knownWhere(known)} → ${anchorWhere(anchor)}`,
        };
    }

    return { error: `unknown Action "${action}"` };
}

function answerFor(item: JudgementItem, known: KnownItem | undefined, agent: string): PostStep | { error: string } {
    const answer = item.fences.get("Proposed answer")?.trim();

    if (item.kind !== "D" && item.kind !== "Y") {
        return { error: "--answers is for my own comments (D, Y)" };
    }

    if (!answer) {
        return { error: "the Proposed answer is empty" };
    }

    if (!known) {
        return { error: "no such item on this MR now; run `review skeleton` again" };
    }

    if (known.pair.kind !== "discussion") {
        return { error: "nobody can reply to an unpublished draft; publish the review first (`comments publish`)" };
    }

    return {
        id: item.id,
        kind: "reply",
        discussionId: known.pair.value,
        body: signedAnswer(item, answer, agent),
        resolve: false,
        where: knownWhere(known),
    };
}

export function planPost(input: PlanInput): PostPlan {
    const plan: PostPlan = { steps: [], skipped: [], errors: [] };
    const byId = new Map(input.judgements.items.map((item) => [item.id, item]));
    const known = new Map(input.known.map((item) => [item.id, item]));
    const take = (
        id: string,
        build: (item: JudgementItem) => PostStep | { skip: string } | { error: string }
    ): void => {
        const item = byId.get(id);

        if (!item) {
            plan.errors.push({ id, message: "no block in the judgements file" });
            return;
        }

        if (!verdictOf(item).trim()) {
            plan.errors.push({ id, message: "not judged (no verdict)" });
            return;
        }

        const result = build(item);

        if ("error" in result) {
            plan.errors.push({ id, message: result.error });
        } else if ("skip" in result) {
            plan.skipped.push({ id, reason: result.skip });
        } else {
            plan.steps.push(result);
        }
    };

    for (const id of normalized(input.ids)) {
        take(id, (item) => stepFor(item, known.get(id), input.agent));
    }

    for (const id of normalized(input.answers)) {
        take(id, (item) => answerFor(item, known.get(id), input.agent));
    }

    return plan;
}

/** One line per step for the dry run: the id, the verb, the target, the first 80 characters. */
export function describeStep(step: PostStep): string {
    const body = "body" in step ? step.body.replace(/\s+/g, " ").trim() : "";
    const verb = step.kind === "reply" && step.resolve ? "reply+resolve" : step.kind;

    return `${step.id.padEnd(4)} ${verb.padEnd(13)} ${step.where}${body ? `  "${body.length > 80 ? `${body.slice(0, 79)}…` : body}"` : ""}`;
}

// ─── ledger ────────────────────────────────────────────────────────────────────

export interface LedgerEntry {
    kind: PostStep["kind"];
    /** The step's whole effect (kind, target, anchor, resolve, text), so changing any of them is a new step. */
    bodyHash: string;
    at: string;
    draftId?: number;
    /** False until the read-back saw the effect on GitLab; a re-run reads such a step back again, never posts it twice. */
    verified?: boolean;
}

export type Ledger = Record<string, LedgerEntry>;

export function stepHash(step: PostStep): string {
    // The id names the step and `where` is derived from the anchor; everything else is the effect.
    const effect = SafeJSON.stringify({ ...step, id: undefined, where: undefined });

    return createHash("sha1").update(effect).digest("hex").slice(0, 16);
}

export function ledgerPath(mr: { host: string; project: string; iid: number }, dir = storage.getBaseDir()): string {
    const project = createHash("sha1").update(`${mr.host} ${mr.project}`).digest("hex").slice(0, 12);

    return join(dir, "review-ledger", `${project}-${mr.iid}.json`);
}

export function loadLedger(path: string): Ledger {
    if (!existsSync(path)) {
        return {};
    }

    try {
        return SafeJSON.parse(readFileSync(path, "utf-8"), { strict: true }) as Ledger;
    } catch (error) {
        logger.warn({ error, path }, "gitlab: review ledger unreadable, starting a new one");

        return {};
    }
}

export function saveLedger(path: string, ledger: Ledger): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, SafeJSON.stringify(ledger, null, 2));
}

/** The step already landed with the same effect: a re-run does not post it again. */
export function alreadyPosted(ledger: Ledger, step: PostStep): LedgerEntry | null {
    const entry = ledger[step.id];

    return entry && entry.kind === step.kind && entry.bodyHash === stepHash(step) ? entry : null;
}

/** Steps that landed but whose read-back has not passed yet: read back again, not posted again. */
export function unverifiedSteps(ledger: Ledger, steps: PostStep[]): PostStep[] {
    return steps.filter((step) => alreadyPosted(ledger, step)?.verified === false);
}

/**
 * The check errors that stop `comments post`: the selected items' own, and every one that belongs to no
 * item of the file (`file`, a broken JSON entry). A fence that swallowed a later item's heading is such an
 * error, and it would post that text inside a selected reply.
 */
export function blockingErrors<T extends { id: string }>(input: {
    errors: T[];
    selected: Set<string>;
    itemIds: Set<string>;
}): T[] {
    return input.errors.filter((error) => input.selected.has(error.id) || !input.itemIds.has(error.id));
}

// ─── read back ─────────────────────────────────────────────────────────────────

const same = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/**
 * What GitLab shows after the run, step by step: null when the step's effect is there, else why not.
 * `draftIds` maps a step id to the draft the run created or updated.
 */
export function readBack(step: PostStep, drafts: DraftSummary[], draftIds: Map<string, number>): string | null {
    const created = drafts.find((draft) => draft.id === draftIds.get(step.id));

    switch (step.kind) {
        case "reply": {
            const reply = drafts.find((draft) => draft.discussionId === step.discussionId);

            return reply && same(reply.note, step.body)
                ? null
                : `no pending reply with this text in thread ${step.discussionId.slice(0, 8)}`;
        }
        case "delete":
            return drafts.some((draft) => draft.id === step.draftId) ? `draft ${step.draftId} is still pending` : null;
        case "reword":
            return created && same(created.note, step.body) ? null : `draft ${step.draftId} does not have the new text`;
        case "move":
        case "comment": {
            if (!created || !same(created.note, step.body)) {
                return "the new draft is not pending with this text";
            }

            if (step.kind === "move" && drafts.some((draft) => draft.id === step.draftId)) {
                return `the old draft ${step.draftId} is still pending`;
            }

            return step.anchor.top || (created.path === step.anchor.path && created.line === step.anchor.line)
                ? null
                : `the draft sits at ${created.path}:${created.line}, not ${anchorWhere(step.anchor)}`;
        }
    }
}
