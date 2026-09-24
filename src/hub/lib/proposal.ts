import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { xxhash } from "@genesiscz/utils/hash";
import { SafeJSON } from "@genesiscz/utils/json";
import { json2md, jsonToBlocks } from "@genesiscz/utils/json2md";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { Storage, withFileLock } from "@genesiscz/utils/storage";

/**
 * A review proposal: what an agent concluded about a PR/MR, pushed into the GenesisTools.app review
 * window so Martin sees every draft comment on the code it is about, with the agent's meta (verdict,
 * proof, confidence, reasoning) stuck to the same lines. Nothing here posts anything: promoting a
 * draft to a real GitHub / GitLab review draft or posting it is a click in the window.
 */

export type ProposalProvider = "github" | "gitlab";
export type ProposalSide = "additions" | "deletions";
export type ProposalSeverity = "blocker" | "major" | "minor" | "nit" | "question" | "praise";
export type ProposalDecision = "approve" | "request_changes" | "comment";
/** proposed (agent) → accepted | edited | rejected (Martin) → drafted (a provider review draft) → posted. */
export type ProposalDraftStatus = "proposed" | "accepted" | "edited" | "rejected" | "drafted" | "posted";

export interface ProposalMeta {
    /** One line: what is wrong or right here, e.g. "Race: the observer is torn down before the POST resolves". */
    verdict: string;
    /** Why the agent believes it: a checkable fact (file:line, test output, spec). */
    proof?: string;
    confidence?: number;
    reasoning?: string;
    refs?: string[];
}

export interface ProposalDraft {
    id: string;
    path: string;
    side: ProposalSide;
    line: number;
    startLine?: number;
    severity: ProposalSeverity;
    /** The comment as it would be posted (markdown). */
    body: string;
    meta: ProposalMeta;
    /** Reply to this existing provider thread instead of opening a new one. */
    replyToThread?: string;
    status: ProposalDraftStatus;
    /** Martin's edited text, when status is `edited`. */
    editedBody?: string;
    /** Provider id once promoted to a review draft or posted. */
    providerId?: string;
}

export interface ProposalThreadVerdict {
    threadId: string;
    path?: string;
    line?: number;
    verdict: "valid" | "invalid" | "already-fixed" | "needs-discussion" | "out-of-scope";
    proof?: string;
    suggestedReply?: string;
}

export interface ReviewProposal {
    version: 1;
    provider: ProposalProvider;
    host: string;
    project: string;
    number: number;
    url?: string;
    title?: string;
    sourceBranch?: string;
    targetBranch?: string;
    baseSha: string;
    headSha: string;
    /** A local checkout that has both commits; the window diffs there. */
    repoPath?: string;
    createdAt: string;
    updatedAt?: string;
    author: { agent: string; sessionId?: string; model?: string };
    verdict: { decision: ProposalDecision; summary: string; confidence?: number; proof?: string };
    drafts: ProposalDraft[];
    threads?: ProposalThreadVerdict[];
    notes?: string;
}

export class ProposalError extends Error {}

const SEVERITIES: ProposalSeverity[] = ["blocker", "major", "minor", "nit", "question", "praise"];
const DECISIONS: ProposalDecision[] = ["approve", "request_changes", "comment"];
const THREAD_VERDICTS: ProposalThreadVerdict["verdict"][] = [
    "valid",
    "invalid",
    "already-fixed",
    "needs-discussion",
    "out-of-scope",
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, path: string, optional = false): string | undefined {
    if (value === undefined && optional) {
        return undefined;
    }

    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ProposalError(`${path} must be a non-empty string`);
    }

    return value;
}

function int(value: unknown, path: string, optional = false): number | undefined {
    if (value === undefined && optional) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new ProposalError(`${path} must be a non-negative integer`);
    }

    return value;
}

/** Diff lines are 1-based: a draft on line 0 cannot be anchored or posted. */
function lineNumber(value: unknown, path: string, optional = false): number | undefined {
    if (value === undefined && optional) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new ProposalError(`${path} must be a positive integer (diff lines are 1-based)`);
    }

    return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
        throw new ProposalError(`${path} must be one of ${allowed.join(", ")}`);
    }

    return value as T;
}

/** Absent means empty; anything else that is not an array is a malformed push, never silently dropped. */
function list(value: unknown, path: string): unknown[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        throw new ProposalError(`${path} must be an array`);
    }

    return value;
}

function parseMeta(value: unknown, path: string): ProposalMeta {
    if (!isRecord(value)) {
        throw new ProposalError(`${path} must be an object with at least a verdict`);
    }

    return {
        verdict: str(value.verdict, `${path}.verdict`) as string,
        proof: str(value.proof, `${path}.proof`, true),
        confidence: int(value.confidence, `${path}.confidence`, true),
        reasoning: str(value.reasoning, `${path}.reasoning`, true),
        refs: Array.isArray(value.refs)
            ? value.refs.filter((ref): ref is string => typeof ref === "string")
            : undefined,
    };
}

function parseDraft(value: unknown, index: number): ProposalDraft {
    const path = `drafts[${index}]`;

    if (!isRecord(value)) {
        throw new ProposalError(`${path} must be an object`);
    }

    const line = lineNumber(value.line, `${path}.line`) as number;
    const startLine = lineNumber(value.startLine, `${path}.startLine`, true);

    if (startLine !== undefined && startLine > line) {
        throw new ProposalError(`${path}.startLine must not be after line`);
    }

    const filePath = str(value.path, `${path}.path`) as string;
    const side = oneOf(value.side ?? "additions", ["additions", "deletions"] as const, `${path}.side`);
    const body = str(value.body, `${path}.body`) as string;
    // Without an explicit id the id comes from the anchor and text, never the position: a draft
    // inserted before it on a later push must not inherit the decision made on this one.
    const implicitId = () => `d-${xxhash([filePath, side, startLine ?? line, line, body].join("\0"))}`;

    return {
        id: str(value.id, `${path}.id`, true) ?? implicitId(),
        path: filePath,
        side,
        line,
        startLine,
        severity: oneOf(value.severity ?? "minor", SEVERITIES, `${path}.severity`),
        body,
        meta: parseMeta(value.meta, `${path}.meta`),
        replyToThread: str(value.replyToThread, `${path}.replyToThread`, true),
        status: "proposed",
    };
}

/** Validates agent input. Status fields are never taken from input: they belong to the window. */
export function parseProposal(value: unknown, now = new Date()): ReviewProposal {
    if (!isRecord(value)) {
        throw new ProposalError("a proposal must be a JSON object");
    }

    if (!isRecord(value.verdict)) {
        throw new ProposalError("verdict must be an object with decision and summary");
    }

    if (!isRecord(value.author)) {
        throw new ProposalError("author must be an object with agent");
    }

    const drafts = (list(value.drafts, "drafts") ?? []).map(parseDraft);
    const ids = new Set<string>();

    for (const draft of drafts) {
        if (ids.has(draft.id)) {
            throw new ProposalError(`draft id ${draft.id} is used twice`);
        }

        ids.add(draft.id);
    }

    const threads = list(value.threads, "threads")?.map((thread, index) => {
        if (!isRecord(thread)) {
            throw new ProposalError(`threads[${index}] must be an object`);
        }

        return {
            threadId: str(thread.threadId, `threads[${index}].threadId`) as string,
            path: str(thread.path, `threads[${index}].path`, true),
            line: lineNumber(thread.line, `threads[${index}].line`, true),
            verdict: oneOf(thread.verdict, THREAD_VERDICTS, `threads[${index}].verdict`),
            proof: str(thread.proof, `threads[${index}].proof`, true),
            suggestedReply: str(thread.suggestedReply, `threads[${index}].suggestedReply`, true),
        };
    });

    return {
        version: 1,
        provider: oneOf(value.provider, ["github", "gitlab"] as const, "provider"),
        host: str(value.host, "host") as string,
        project: str(value.project, "project") as string,
        number: int(value.number, "number") as number,
        url: str(value.url, "url", true),
        title: str(value.title, "title", true),
        sourceBranch: str(value.sourceBranch, "sourceBranch", true),
        targetBranch: str(value.targetBranch, "targetBranch", true),
        baseSha: str(value.baseSha, "baseSha") as string,
        headSha: str(value.headSha, "headSha") as string,
        repoPath: str(value.repoPath, "repoPath", true),
        createdAt: now.toISOString(),
        author: {
            agent: str(value.author.agent, "author.agent") as string,
            sessionId: str(value.author.sessionId, "author.sessionId", true),
            model: str(value.author.model, "author.model", true),
        },
        verdict: {
            decision: oneOf(value.verdict.decision, DECISIONS, "verdict.decision"),
            summary: str(value.verdict.summary, "verdict.summary") as string,
            confidence: int(value.verdict.confidence, "verdict.confidence", true),
            proof: str(value.verdict.proof, "verdict.proof", true),
        },
        drafts,
        threads,
        notes: str(value.notes, "notes", true),
    };
}

/**
 * The slug keeps the key readable; the hash of the exact host and project keeps it unique, because
 * the slug alone maps `group/a-b` and `group/a/b` to the same file.
 */
export function proposalKey(proposal: Pick<ReviewProposal, "provider" | "host" | "project" | "number">): string {
    const where = `${proposal.host}/${proposal.project}`;
    const slug = where.replace(/[^A-Za-z0-9._-]+/g, "-");
    return `${proposal.provider}__${slug}-${xxhash(where).slice(0, 8)}__${proposal.number}`;
}

/** The fields the list, the key and the sort read; a stored file without them is skipped, not fatal. */
function isStoredProposal(value: unknown): value is ReviewProposal {
    return (
        isRecord(value) &&
        typeof value.provider === "string" &&
        typeof value.host === "string" &&
        typeof value.project === "string" &&
        typeof value.number === "number" &&
        typeof value.createdAt === "string" &&
        (value.updatedAt === undefined || typeof value.updatedAt === "string") &&
        isRecord(value.verdict) &&
        Array.isArray(value.drafts)
    );
}

/** The proposal a new push merges into; a file of another shape is refused, since overwriting it drops decisions. */
function readStoredProposal(path: string): ReviewProposal | null {
    if (!existsSync(path)) {
        return null;
    }

    const stored: unknown = SafeJSON.parse(readFileSync(path, "utf8"));

    if (!isStoredProposal(stored)) {
        throw new ProposalError(`${path} is not a stored proposal; move it aside before pushing again`);
    }

    return stored;
}

export function proposalsDir(base?: string): string {
    return join(base ?? new Storage("review").getBaseDir(), "proposals");
}

/**
 * Stores a proposal. A second push for the same PR keeps what Martin already decided: a draft with
 * the same id keeps its status, edited text and provider id; the agent's new drafts start `proposed`.
 */
/**
 * Read, merge and write under `<file>.lock`, the lock the review window's `ProposalDocument.update`
 * also takes (Review/FileLock.swift): otherwise a push and a click in the window can both read the old
 * file, and the later write drops the other's drafts or decision.
 */
export async function saveProposal(
    incoming: ReviewProposal,
    base?: string
): Promise<{ key: string; path: string; kept: number }> {
    const dir = proposalsDir(base);
    mkdirSync(dir, { recursive: true });
    const key = proposalKey(incoming);
    const path = join(dir, `${key}.json`);

    return withFileLock(`${path}.lock`, async () => mergeAndWrite({ incoming, key, path }));
}

function mergeAndWrite({ incoming, key, path }: { incoming: ReviewProposal; key: string; path: string }): {
    key: string;
    path: string;
    kept: number;
} {
    const previous = readStoredProposal(path);
    let kept = 0;

    const drafts = incoming.drafts.map((draft) => {
        const before = previous?.drafts.find((old) => old.id === draft.id);

        if (!before || before.status === "proposed") {
            return draft;
        }

        kept += 1;
        return { ...draft, status: before.status, editedBody: before.editedBody, providerId: before.providerId };
    });

    const merged: ReviewProposal = {
        ...incoming,
        createdAt: previous?.createdAt ?? incoming.createdAt,
        updatedAt: incoming.createdAt,
        drafts,
    };
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${SafeJSON.stringify(merged, null, 2)}\n`);
    renameSync(temp, path);
    logger.debug({ key, path, drafts: drafts.length, kept }, "review proposal saved");
    return { key, path, kept };
}

export function listProposals(base?: string): ReviewProposal[] {
    const dir = proposalsDir(base);

    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => {
            try {
                const parsed: unknown = SafeJSON.parse(readFileSync(join(dir, name), "utf8"));

                if (!isStoredProposal(parsed)) {
                    logger.warn({ name }, "review proposal skipped: not a stored proposal");
                    return [];
                }

                return [parsed];
            } catch (err) {
                logger.warn({ err, name }, "review proposal unreadable");
                return [];
            }
        })
        .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
}

export function proposalMarkdown(proposal: ReviewProposal): string {
    const where = (draft: ProposalDraft) =>
        `${draft.path}:${draft.startLine && draft.startLine !== draft.line ? `${draft.startLine}-` : ""}${draft.line}`;

    return json2md(
        jsonToBlocks({
            Verdict: {
                decision: proposal.verdict.decision,
                confidence: proposal.verdict.confidence === undefined ? "—" : `${proposal.verdict.confidence}%`,
                summary: proposal.verdict.summary,
                proof: proposal.verdict.proof ?? "—",
            },
            "Draft comments": proposal.drafts.map((draft) => ({
                where: where(draft),
                severity: draft.severity,
                status: draft.status,
                verdict: draft.meta.verdict,
                confidence: draft.meta.confidence === undefined ? "—" : `${draft.meta.confidence}%`,
                comment: draft.editedBody ?? draft.body,
            })),
            ...(proposal.threads?.length ? { "Existing threads": proposal.threads } : {}),
            ...(proposal.notes ? { Notes: proposal.notes } : {}),
        }),
        {
            title: `${proposal.provider === "gitlab" ? "!" : "#"}${proposal.number} ${proposal.title ?? proposal.project}`,
        }
    );
}

/**
 * The hard gate for other tools (private review skills included): is a GenesisTools.app with the
 * review window installed on this Mac? Checks the bundle and its bundled diff viewer; never builds.
 */
export function hubStatus(): { available: boolean; bundlePath: string; reason?: string } {
    const bundlePath = genesisAppBundlePath();

    if (!existsSync(bundlePath)) {
        return {
            available: false,
            bundlePath,
            reason: "GenesisTools.app is not installed (tools macos permissions build)",
        };
    }

    if (!existsSync(join(bundlePath, "Contents", "Resources", "diff-viewer", "index.html"))) {
        return { available: false, bundlePath, reason: "GenesisTools.app predates the review window; rebuild it" };
    }

    return { available: true, bundlePath };
}
