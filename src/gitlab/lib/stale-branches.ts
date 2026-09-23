/**
 * Open-MR staleness report in two steps: `preflight` writes every fact plus empty review fields,
 * an agent fills the review fields, `render` turns the filled JSON into a Markdown note. The
 * renderer never invents a recommendation.
 */

import { getProject, type ProjectApi, restGet } from "@app/gitlab/lib/client";
import {
    type ClosedBugContext,
    type ClosedBugFacts,
    closedBugOf,
    closedBugSummary,
    FIX_LOCATIONS_TO_REPORT,
} from "@app/gitlab/lib/closed-bug";
import { type GitLabToolConfig, messagesOf } from "@app/gitlab/lib/config";
import { formatDate, getDateStyle } from "@app/gitlab/lib/dates";
import { gitResult } from "@app/gitlab/lib/git";
import { errorMessage } from "@app/gitlab/lib/http";
import { markdownCell } from "@app/gitlab/lib/markdown";
import {
    fetchMrApprovals,
    fetchMrNotes,
    findMrsByWorkItemId,
    listOpenMrs,
    type MrApprovals,
    type MrNote,
    type MrSummary,
} from "@app/gitlab/lib/merge-requests";
import { pool } from "@app/gitlab/lib/pool";
import {
    collectShipped,
    environmentRefs,
    labelConflicts,
    type ShippedFacts,
    type ShippedRoles,
} from "@app/gitlab/lib/shipped";
import {
    type AdoFetchError,
    type AdoWorkItem,
    extractWorkItemIds,
    resolveAdo,
    workItemUrl,
} from "@app/gitlab/lib/work-items";
import { SafeJSON } from "@genesiscz/utils/json";

export { formatDate };

export const RECOMMENDATIONS = ["CLOSE", "ASK AUTHOR", "REBASE-NEEDED", "KEEP"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export interface ReviewFields {
    recommendation: Recommendation | null;
    /** 0 to 100. */
    confidence: number | null;
    reason: string | null;
    adoCommentsSummary: string | null;
    /** Ready to paste into the MR, in the team's language and voice. */
    draftComment: string | null;
    /** Label changes for `stale-branches apply-labels`; empty when nothing should change. */
    labels: LabelAction[];
    /** Read-only commands the reviewing agent ran beyond this JSON, one per entry. */
    evidence: string[];
    /** Set by `stale-branches post --draft`: a GitLab draft note, visible only to its author until published. */
    draftNoteId?: number;
    draftedAt?: string;
    /** The exact text sent as the draft note, so `sync-note` can tell what was appended since. */
    sentBody?: string;
    /** Set by `stale-branches post` or `publish` after this one draft was approved. */
    postedNoteUrl?: string;
    postedAt?: string;
    /** Set by `stale-branches apply-labels` after the labels were changed on GitLab. */
    labelsBefore?: string[];
    labelsAfter?: string[];
    labelsAppliedAt?: string;
    /** Set by `stale-branches close` in the follow-up phase, after closing this one MR was approved. */
    closedAt?: string;
    /** Set by `stale-branches close --delete-branch` after the source branch was deleted on origin. */
    sourceBranchDeletedAt?: string;
}

export const LABEL_ACTIONS = ["add", "remove"] as const;

export interface LabelAction {
    type: (typeof LABEL_ACTIONS)[number];
    label: string;
}

export function emptyReview(): ReviewFields {
    return {
        recommendation: null,
        confidence: null,
        reason: null,
        adoCommentsSummary: null,
        draftComment: null,
        labels: [],
        evidence: [],
    };
}

export function normalizeEvidence(value: unknown): string[] {
    if (value === null || value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error(`review.evidence must be an array of strings, got ${SafeJSON.stringify(value)}`);
    }

    return value.map((entry: string) => entry.trim()).filter(Boolean);
}

export function normalizeLabels(value: unknown): LabelAction[] {
    if (value === null || value === undefined) {
        return [];
    }

    if (!Array.isArray(value)) {
        throw new Error(`review.labels must be an array of {type, label}, got ${SafeJSON.stringify(value)}`);
    }

    return value.map((entry) => {
        const type = (entry as LabelAction).type;
        const label = (entry as LabelAction).label;
        if (!LABEL_ACTIONS.includes(type) || typeof label !== "string" || !label.trim()) {
            throw new Error(
                `Invalid label action ${SafeJSON.stringify(entry)}; expected {type: "add" | "remove", label: "<name>"}`
            );
        }

        return { type, label: label.trim() };
    });
}

export interface GitFacts {
    sourceMissing: boolean;
    targetMissing: boolean;
    behind: number | null;
    ahead: number | null;
    lastCommitDate: string | null;
    lastCommitAuthor: string | null;
    lastCommitEmail: string | null;
}

export interface AdoFacts {
    id: number;
    source: "title" | "branch" | "description";
    item: AdoWorkItem | null;
    /** The parent when `item` is a Task, otherwise the same as `item`. */
    effective: AdoWorkItem | null;
    error: AdoFetchError | null;
    parentError: AdoFetchError | null;
}

export const SIBLING_RELATIONS = ["same-ado", "stacked-on-this", "this-stacks-on"] as const;

export interface SiblingMr {
    iid: number;
    title: string;
    state: string;
    sourceBranch: string;
    targetBranch: string;
    updatedAt: string;
    webUrl: string;
    relation: (typeof SIBLING_RELATIONS)[number];
}

export interface StaleMr extends MrSummary {
    ageDays: number;
    daysSinceUpdate: number;
    git: GitFacts;
    /** Newest first: every human note plus the system notes that carry state (approvals, merges, branch changes), capped. */
    notes: MrNote[];
    lastNote: MrNote | null;
    lastHumanNote: MrNote | null;
    approvals: MrApprovals | null;
    /** Content check of the branch against the environment refs. Null when a branch is missing. */
    shipped: ShippedFacts | null;
    /** Labels that claim a merge state the content check contradicts. */
    labelConflicts: string[];
    /** Other MRs on the same work item, and MRs stacked on this branch or under it. */
    siblings: SiblingMr[];
    ado: AdoFacts | null;
    /** Further work items named in the title, branch or description, after the primary one. */
    adoExtra: AdoFacts[];
    needsReview: boolean;
    review: ReviewFields;
    /** One-off comments posted by `side-comment`, keyed so the same sweep never posts twice. */
    sideComments?: SideComment[];
    /** Set when the work item is a Closed Bug: where the MR content is by the content check. */
    closedBug?: ClosedBugFacts | null;
}

export interface SideComment {
    key: string;
    body: string;
    /** Set when the text went out as a GitLab draft note; cleared by `publish`. */
    draftNoteId?: number;
    postedNoteUrl?: string;
    postedAt?: string;
}

export interface AuthorFacts {
    username: string;
    gitlabState: string;
    lastGitlabEvent: string | null;
    lastGitlabEventError: string | null;
    gitIdentities: string[];
    lastCommitDate: string | null;
    openMrs: number;
    oldestMrAgeDays: number;
    oldestMrIid: number;
}

export interface StaleReport {
    _instructions: string;
    generatedAt: string;
    asOfDate: string;
    /** GitLab instance and project the sweep read, so every later subcommand writes to the same place. */
    host: string;
    project: string;
    defaultBranch: string;
    repoRoot: string;
    reviewMinAgeDays: number;
    inactiveAfterDays: number;
    mrs: StaleMr[];
    authors: AuthorFacts[];
    /** Refs the content check searched: UAT, production and test, in that order, when configured. */
    shippedRefs: string[];
    shippedRoles: ShippedRoles;
    failures: string[];
    commands: string[];
}

const DEFAULT_DRAFT_COMMENT_GUIDE =
    "draftComment: a short comment to the MR author, ready to paste: one line of context; the work item with its type, state, creation date and last activity (who, and what the last comment said); the branch; the code state (the shipped verdict in words); related MRs; then what should happen: that the stale label is being added, the ask with a `[<confidence>%]` badge, and the date of the next cleanup pass. The first pass never says the MR is being closed now. Never post it yourself.";

function instructions(config: GitLabToolConfig): string {
    return [
        "Fill `review` on every MR where `needsReview` is true. Leave every other field untouched.",
        "recommendation: one of CLOSE, ASK AUTHOR, REBASE-NEEDED, KEEP. confidence: 0-100.",
        "reason: two or three sentences grounded in the facts of this MR (work item state, comments, distance behind target, author activity).",
        "Read `shipped` before any CLOSE: `present` means the branch content is already on a target ref, `absent` means no sampled line of it is on any ref, so closing drops the fix. A Closed work item with `shipped.verdict` absent is a contradiction to report, not a reason to close.",
        "`labels` on the MR are claims by people, not facts; `labelConflicts` lists the ones the content check contradicts. `approvals` lists who approved. `siblings` lists other MRs on the same work item and stacked MRs. `adoExtra` holds further work items named by the MR.",
        "`closedBug` is set when the work item (the parent for a Task) is a Closed Bug: `fix` says where the MR content is by the content check (`released`, `unreleased` = on the test environment only, `partial`, `nowhere`, `unknown`), with the closing date and person, and `comment` is the text the `closed-bug` command appends to our comment (recomputed with the exhaustive check at send time). `unreleased` is a release-flow defect (the bug was closed after a test and the MR never merged), not a staleness verdict. When `closedBug` is set, keep the code line of the review consistent with `closedBug.fix`, and do not repeat `closedBug.comment` in `draftComment`: it goes out in the same note.",
        "adoCommentsSummary: what the work item comments say, in plain English, newest first. Null when there are no comments.",
        config.stale.draftCommentGuide ?? DEFAULT_DRAFT_COMMENT_GUIDE,
        "labels: array of {type: add | remove, label: <existing project label>} to apply with `stale-branches apply-labels`; [] when the labels should stay. Use only labels already present on other MRs of this report.",
        "evidence: array of the read-only commands you ran beyond this JSON (for example `git show origin/main:<path>`), one string each; [] when you used only this file.",
        "Then run: tools gitlab stale-branches render <this file> --out <note.md>",
    ].join(" ");
}

const STATE_SYSTEM_NOTE =
    /approved this merge request|unapproved this merge request|merged|changed target branch|changed the description|added \d+ commits?|marked this merge request as (draft|ready)|reset approvals|resolved all threads|requested review/i;

/**
 * Newest first: every human note, plus the system notes that change the story (approvals,
 * merges, target changes, pushes, draft toggles). Capped so a chatty thread cannot dominate the
 * JSON. The first human note is kept even past the cap, because it states the intent of the MR.
 */
export function noteWindow(notes: MrNote[], cap = 20): MrNote[] {
    const sorted = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const kept = sorted.filter((n) => !n.system || STATE_SYSTEM_NOTE.test(n.body));
    if (kept.length <= cap) {
        return kept;
    }

    const window = kept.slice(0, cap);
    const firstHuman = [...kept].reverse().find((n) => !n.system);
    if (firstHuman && !window.includes(firstHuman)) {
        window[cap - 1] = firstHuman;
    }

    return window;
}

function daysBetween(fromIso: string, to: Date): number {
    return Math.floor((to.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

function refExists(cwd: string, ref: string): boolean {
    return gitResult(cwd, ["rev-parse", "--verify", "--quiet", ref]).exitCode === 0;
}

function countRange(cwd: string, range: string): number | null {
    const r = gitResult(cwd, ["rev-list", "--count", range]);

    return r.exitCode === 0 ? Number(r.stdout.trim()) : null;
}

export function gitFacts(cwd: string, mr: MrSummary): GitFacts {
    const src = `origin/${mr.sourceBranch}`;
    const tgt = `origin/${mr.targetBranch}`;
    const sourceMissing = !refExists(cwd, src);
    const targetMissing = !refExists(cwd, tgt);
    const facts: GitFacts = {
        sourceMissing,
        targetMissing,
        behind: null,
        ahead: null,
        lastCommitDate: null,
        lastCommitAuthor: null,
        lastCommitEmail: null,
    };
    if (!sourceMissing && !targetMissing) {
        facts.behind = countRange(cwd, `${src}..${tgt}`);
        facts.ahead = countRange(cwd, `${tgt}..${src}`);
    }

    if (!sourceMissing) {
        const r = gitResult(cwd, ["log", "-1", "--format=%cs%x00%an%x00%ae", src]);
        if (r.exitCode === 0) {
            const [date, author, email] = r.stdout.trim().split("\0");
            facts.lastCommitDate = date ?? null;
            facts.lastCommitAuthor = author ?? null;
            facts.lastCommitEmail = email ?? null;
        }
    }

    return facts;
}

function lastCommitByEmails(cwd: string, emails: string[]): string | null {
    let max: string | null = null;
    for (const email of emails) {
        const r = gitResult(cwd, ["log", "--all", "-1", "--format=%cs", `--author=${email}`]);
        const date = r.stdout.trim();
        if (r.exitCode === 0 && date && (!max || date > max)) {
            max = date;
        }
    }

    return max;
}

async function lastGitlabEvent(
    api: ProjectApi,
    userId: number
): Promise<{ date: string | null; error: string | null }> {
    try {
        const events = await restGet<Array<{ created_at: string }>>(api, `/users/${userId}/events?per_page=1`);

        return { date: events[0]?.created_at.slice(0, 10) ?? null, error: null };
    } catch (e: unknown) {
        return { date: null, error: errorMessage(e) };
    }
}

/** What `closed-bug` and the closed-bug facts need from a report and the config. */
export function closedBugContextOf(
    report: Pick<StaleReport, "shippedRoles" | "project">,
    config: GitLabToolConfig,
    types?: string[]
): ClosedBugContext {
    return { roles: report.shippedRoles, messages: messagesOf(config), projectPath: report.project, types };
}

export interface CollectOptions {
    api: ProjectApi;
    config: GitLabToolConfig;
    cwd: string;
    reviewMinAgeDays: number;
    inactiveAfterDays: number;
    now?: Date;
    log?: (line: string) => void;
}

export async function collectStaleReport(options: CollectOptions): Promise<StaleReport> {
    const now = options.now ?? new Date();
    const log = options.log ?? (() => {});
    const failures: string[] = [];
    const { cwd, config } = options;
    const fetchResult = gitResult(cwd, ["fetch", "origin", "--prune", "--quiet"]);
    if (fetchResult.exitCode !== 0) {
        failures.push(`git fetch origin --prune: ${fetchResult.stderr.trim()}`);
    }

    const project = await getProject(options.api, options.api.project);
    const api: ProjectApi = { ...options.api, project: project.path_with_namespace };
    const open = await listOpenMrs(api);
    log(`${open.length} open MRs in ${project.path_with_namespace}`);
    const asOfDate = now.toISOString().slice(0, 10);
    const environments = environmentRefs({
        cwd,
        environments: config.stale.environments,
        defaultBranch: project.default_branch,
        asOf: asOfDate,
    });
    failures.push(...environments.failures);
    const shippedRefs = environments.refs;
    const closedBugContext = closedBugContextOf({ shippedRoles: environments.roles, project: api.project }, config);
    const idPattern = config.workItems.idPattern;
    const adoCache = new Map<number, Promise<AdoFacts>>();
    const adoFacts = (id: number, source: AdoFacts["source"], iid: number): Promise<AdoFacts> => {
        let pending = adoCache.get(id);
        if (!pending) {
            pending = resolveAdo(id, { config: config.workItems, cwd }).then((resolved) =>
                "error" in resolved
                    ? { id, source, item: null, effective: null, error: resolved, parentError: null }
                    : {
                          id,
                          source,
                          item: resolved.item,
                          effective: resolved.effective,
                          error: null,
                          parentError: resolved.parentError,
                      }
            );
            adoCache.set(id, pending);
        }

        return pending.then((facts) => {
            if (facts.error) {
                failures.push(`ADO ${id} (from !${iid} ${source}): ${facts.error.error}`);
            }

            if (facts.parentError) {
                failures.push(
                    `ADO ${id} is a Task and its parent ${facts.parentError.id} is unreadable (from !${iid}): ${facts.parentError.error}`
                );
            }

            return { ...facts, source };
        });
    };

    const mrs = await pool(open, 6, async (mr): Promise<StaleMr> => {
        const git = gitFacts(cwd, mr);
        let notes: MrNote[] = [];
        try {
            notes = noteWindow(await fetchMrNotes(api, mr.iid, 100));
        } catch (e: unknown) {
            failures.push(`notes of !${mr.iid}: ${errorMessage(e)}`);
        }

        let approvals: MrApprovals | null = null;
        try {
            approvals = await fetchMrApprovals(api, mr.iid);
        } catch (e: unknown) {
            failures.push(`approvals of !${mr.iid}: ${errorMessage(e)}`);
        }

        const shipped =
            git.sourceMissing || git.targetMissing
                ? null
                : collectShipped({
                      cwd,
                      sourceRef: `origin/${mr.sourceBranch}`,
                      targetRef: `origin/${mr.targetBranch}`,
                      checkRefs: shippedRefs,
                  });

        const ids = [
            ...extractWorkItemIds(idPattern, mr.title).map((id) => ({ id, source: "title" as const })),
            ...extractWorkItemIds(idPattern, mr.sourceBranch).map((id) => ({ id, source: "branch" as const })),
            ...extractWorkItemIds(idPattern, mr.description).map((id) => ({ id, source: "description" as const })),
        ].filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index);
        const primary = ids[0];
        const ado = primary ? await adoFacts(primary.id, primary.source, mr.iid) : null;
        const adoExtra: AdoFacts[] = [];
        for (const extra of ids.slice(1, 3)) {
            adoExtra.push(await adoFacts(extra.id, extra.source, mr.iid));
        }

        const ageDays = daysBetween(mr.createdAt, now);
        log(
            `!${mr.iid} ${ageDays} d, work item ${primary?.id ?? "none"}${ids.length > 1 ? ` +${ids.length - 1}` : ""}, shipped ${shipped?.verdict ?? "n/a"}`
        );

        const facts: StaleMr = {
            ...mr,
            ageDays,
            daysSinceUpdate: daysBetween(mr.updatedAt, now),
            git,
            notes,
            lastNote: notes[0] ?? null,
            lastHumanNote: notes.find((n) => !n.system) ?? null,
            approvals,
            shipped,
            labelConflicts: shipped ? labelConflicts(mr.labels, shipped, config.stale.mergeLabelPattern) : [],
            siblings: [],
            ado,
            adoExtra,
            needsReview: ageDays > options.reviewMinAgeDays,
            review: emptyReview(),
        };
        facts.closedBug = closedBugOf(facts, closedBugContext);

        return facts;
    });

    const siblingCache = new Map<number, MrSummary[]>();
    const adoIds = [
        ...new Set(
            mrs
                .flatMap((m) => [m.ado, ...m.adoExtra])
                .filter((a): a is AdoFacts => a !== null)
                .map((a) => a.id)
        ),
    ];
    await pool(adoIds, 4, async (id) => {
        try {
            siblingCache.set(id, await findMrsByWorkItemId(api, id, open));
        } catch (e: unknown) {
            failures.push(`sibling MRs of work item ${id}: ${errorMessage(e)}`);
        }
    });
    for (const mr of mrs) {
        mr.siblings = siblingsOf(mr, mrs, siblingCache);
    }

    const byAuthor = new Map<string, StaleMr[]>();
    for (const mr of mrs) {
        byAuthor.set(mr.author.username, [...(byAuthor.get(mr.author.username) ?? []), mr]);
    }

    const authors = await pool([...byAuthor.entries()], 4, async ([username, list]): Promise<AuthorFacts> => {
        const emails = [...new Set(list.map((m) => m.git.lastCommitEmail).filter((e): e is string => Boolean(e)))];
        const identities = [
            ...new Set(
                list
                    .map((m) => `${m.git.lastCommitAuthor} <${m.git.lastCommitEmail}>`)
                    .filter((s) => !s.startsWith("null"))
            ),
        ];
        const oldest = list.reduce((a, b) => (a.ageDays >= b.ageDays ? a : b));
        const first = list[0];
        const event = first ? await lastGitlabEvent(api, first.author.id) : { date: null, error: "no MR" };
        if (event.error) {
            failures.push(`GitLab events of ${username}: ${event.error}`);
        }

        return {
            username,
            gitlabState: first?.author.state ?? "unknown",
            lastGitlabEvent: event.date,
            lastGitlabEventError: event.error,
            gitIdentities: identities,
            lastCommitDate: lastCommitByEmails(cwd, emails),
            openMrs: list.length,
            oldestMrAgeDays: oldest.ageDays,
            oldestMrIid: oldest.iid,
        };
    });

    const mrApi = `GET ${api.host}/api/v4/projects/:id/merge_requests`;

    return {
        _instructions: instructions(config),
        generatedAt: now.toISOString(),
        asOfDate,
        host: api.host,
        project: api.project,
        defaultBranch: project.default_branch,
        repoRoot: cwd,
        reviewMinAgeDays: options.reviewMinAgeDays,
        inactiveAfterDays: options.inactiveAfterDays,
        mrs: mrs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        authors: authors.sort((a, b) => b.oldestMrAgeDays - a.oldestMrAgeDays),
        shippedRefs,
        shippedRoles: environments.roles,
        failures,
        commands: [
            "git fetch origin --prune --quiet",
            `${mrApi}?state=opened (paginated)`,
            `${mrApi}/<iid>/notes?sort=desc&order_by=updated_at&per_page=100  (kept: human notes plus state-carrying system notes, cap 20)`,
            `${mrApi}/<iid>/approvals`,
            ...(idPattern
                ? [
                      `${mrApi}?state=all&search=<work item id>&in=title,description  (sibling MRs, one call per work item)`,
                  ]
                : []),
            `GET ${api.host}/api/v4/users/<id>/events?per_page=1`,
            "git rev-parse --verify --quiet origin/<branch>",
            "git rev-list --count origin/<src>..origin/<target>  (behind) and the reverse (ahead)",
            "git log -1 --format=%cs%x00%an%x00%ae origin/<src>",
            `git merge-base origin/<src> origin/<target>; git diff --numstat <base> origin/<src>; git diff -U0 <base> origin/<src> -- <file>; git show <ref>:<file>  (content check against ${shippedRefs.join(", ")}; ancestry is not used)`,
            "git log --all -1 --format=%cs --author=<email>  (per email seen on the author's MR branches)",
            ...(idPattern
                ? [
                      "tools azure-devops workitem <id> -f json --force  (plus the parent when the item is a Task, plus every further id the MR names)",
                  ]
                : []),
        ],
    };
}

function siblingsOf(mr: StaleMr, all: StaleMr[], byAdo: Map<number, MrSummary[]>): SiblingMr[] {
    const result = new Map<number, SiblingMr>();
    const add = (other: MrSummary, relation: SiblingMr["relation"]) => {
        if (other.iid !== mr.iid && !result.has(other.iid)) {
            result.set(other.iid, {
                iid: other.iid,
                title: other.title,
                state: other.state,
                sourceBranch: other.sourceBranch,
                targetBranch: other.targetBranch,
                updatedAt: other.updatedAt,
                webUrl: other.webUrl,
                relation,
            });
        }
    };
    for (const other of all) {
        if (other.targetBranch === mr.sourceBranch) {
            add(other, "stacked-on-this");
        }

        if (mr.targetBranch === other.sourceBranch) {
            add(other, "this-stacks-on");
        }
    }

    for (const facts of [mr.ado, ...mr.adoExtra]) {
        for (const other of facts ? (byAdo.get(facts.id) ?? []) : []) {
            add(other, "same-ado");
        }
    }

    return [...result.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ─── freshness (before posting a stored draft) ─────────────────────────────────

export interface FreshnessResult {
    changed: boolean;
    details: string[];
}

/** What moved on the MR and its work item since the sweep. Any difference means the draft may be stale. */
export function freshness(mr: StaleMr, live: MrSummary, liveAdo: AdoWorkItem | null): FreshnessResult {
    const details: string[] = [];
    if (live.state !== mr.state) {
        details.push(`MR state ${mr.state} -> ${live.state}`);
    }

    if (live.sha !== mr.sha) {
        details.push(`new commits on the branch (${mr.sha.slice(0, 8)} -> ${live.sha.slice(0, 8)})`);
    }

    if (live.draft !== mr.draft) {
        details.push(live.draft ? "MR marked as draft" : "MR marked ready");
    }

    if (live.targetBranch !== mr.targetBranch) {
        details.push(`target branch ${mr.targetBranch} -> ${live.targetBranch}`);
    }

    if (live.userNotesCount !== mr.userNotesCount) {
        details.push(`notes ${mr.userNotesCount} -> ${live.userNotesCount}`);
    }

    const labelsBefore = [...mr.labels].sort().join(", ");
    const labelsNow = [...live.labels].sort().join(", ");
    if (labelsBefore !== labelsNow) {
        details.push(`labels ${labelsBefore || "(none)"} -> ${labelsNow || "(none)"}`);
    }

    const storedAdo = mr.ado?.effective ?? mr.ado?.item ?? null;
    if (storedAdo && liveAdo) {
        if (liveAdo.state !== storedAdo.state) {
            details.push(`ADO ${storedAdo.id} state ${storedAdo.state} -> ${liveAdo.state}`);
        }

        if (liveAdo.changed !== storedAdo.changed) {
            details.push(
                `ADO ${storedAdo.id} changed ${formatDate(storedAdo.changed)} -> ${formatDate(liveAdo.changed)} by ${liveAdo.changedBy ?? "unknown"}`
            );
        }

        if (liveAdo.comments.length !== storedAdo.comments.length) {
            details.push(`ADO ${storedAdo.id} comments ${storedAdo.comments.length} -> ${liveAdo.comments.length}`);
        }
    }

    return { changed: details.length > 0, details };
}

// ─── merge ─────────────────────────────────────────────────────────────────────

export type ReviewSource = Record<string, ReviewFields> | StaleReport;

const OPERATIONAL_FIELDS = [
    "draftNoteId",
    "draftedAt",
    "sentBody",
    "postedNoteUrl",
    "postedAt",
    "labelsBefore",
    "labelsAfter",
    "labelsAppliedAt",
    "closedAt",
    "sourceBranchDeletedAt",
] as const;

/** What `post`, `apply-labels` and `close` wrote: a re-merged judgment must never erase it. */
export function operationalState(review: Partial<ReviewFields> | undefined): Partial<ReviewFields> {
    const state: Partial<ReviewFields> = {};
    for (const field of OPERATIONAL_FIELDS) {
        const value = review?.[field];
        if (value !== undefined && value !== null) {
            (state as Record<string, unknown>)[field] = value;
        }
    }

    return state;
}

function isReport(source: ReviewSource): source is StaleReport {
    return Array.isArray((source as StaleReport).mrs);
}

/**
 * Copy filled `review` fields into `report` by MR iid. A source is either a `{ "<iid>": review }`
 * map (agent slice output) or a whole report whose MRs already carry reviews (a previous sweep).
 * Later sources win.
 */
export function mergeReviews(report: StaleReport, sources: ReviewSource[]): { filled: number; missing: number[] } {
    const reviews = new Map<number, ReviewFields>();
    for (const source of sources) {
        if (isReport(source)) {
            for (const mr of source.mrs) {
                if (mr.review.recommendation) {
                    reviews.set(mr.iid, mr.review);
                }
            }
        } else {
            for (const [iid, review] of Object.entries(source)) {
                reviews.set(Number(iid), review);
            }
        }
    }

    let filled = 0;
    const missing: number[] = [];
    for (const mr of report.mrs) {
        if (!mr.needsReview) {
            continue;
        }

        const review = reviews.get(mr.iid);
        if (!review) {
            missing.push(mr.iid);
            continue;
        }

        mr.review = {
            ...operationalState(mr.review),
            ...operationalState(review),
            recommendation: review.recommendation ?? null,
            confidence:
                review.confidence === null || review.confidence === undefined ? null : Number(review.confidence),
            reason: review.reason ?? null,
            adoCommentsSummary: review.adoCommentsSummary ?? null,
            draftComment: review.draftComment ?? null,
            labels: normalizeLabels(review.labels),
            evidence: normalizeEvidence(review.evidence),
        };
        filled++;
    }

    return { filled, missing };
}

// ─── posting (one MR, after an explicit per-MR approval) ───────────────────────

export function findReviewedMr(report: StaleReport, iid: number): StaleMr {
    const mr = report.mrs.find((m) => m.iid === iid);
    if (!mr) {
        throw new Error(`!${iid} is not in this report`);
    }

    if (!mr.needsReview || !mr.review.draftComment) {
        throw new Error(`!${iid} has no drafted comment to post`);
    }

    if (mr.review.postedNoteUrl) {
        throw new Error(`!${iid} was already posted: ${mr.review.postedNoteUrl}`);
    }

    return mr;
}

export function markPosted(mr: StaleMr, noteId: number, now = new Date()): string {
    const url = `${mr.webUrl}#note_${noteId}`;
    mr.review.postedNoteUrl = url;
    mr.review.postedAt = now.toISOString();

    return url;
}

// ─── labels (batch, after the dry-run table was approved) ──────────────────────

export interface PendingLabels {
    mr: StaleMr;
    add: string[];
    remove: string[];
}

/** Reviewed MRs with label actions that were not applied yet. `iid` narrows to one MR. */
export function pendingLabels(report: StaleReport, iid?: number): PendingLabels[] {
    const result: PendingLabels[] = [];
    for (const mr of report.mrs) {
        if (iid !== undefined && mr.iid !== iid) {
            continue;
        }

        const labels = normalizeLabels(mr.review.labels);
        if (!labels.length || mr.review.labelsAppliedAt) {
            continue;
        }

        const add = labels.filter((l) => l.type === "add").map((l) => l.label);
        const remove = labels.filter((l) => l.type === "remove").map((l) => l.label);
        const overlap = add.filter((l) => remove.includes(l));
        if (overlap.length) {
            throw new Error(`!${mr.iid} adds and removes the same label: ${overlap.join(", ")}`);
        }

        result.push({ mr, add, remove });
    }

    if (iid !== undefined && !result.length) {
        throw new Error(`!${iid} has no pending label changes in this report`);
    }

    return result;
}

export function markLabelsApplied(mr: StaleMr, labels: { before: string[]; after: string[]; now?: Date }): void {
    mr.review.labelsBefore = labels.before;
    mr.review.labelsAfter = labels.after;
    mr.review.labelsAppliedAt = (labels.now ?? new Date()).toISOString();
}

// ─── validation ────────────────────────────────────────────────────────────────

export function unfilledReviews(report: StaleReport): number[] {
    return report.mrs
        .filter((mr) => mr.needsReview)
        .filter((mr) => {
            const r = mr.review;

            return (
                r.recommendation === null ||
                !RECOMMENDATIONS.includes(r.recommendation) ||
                r.confidence === null ||
                !r.reason ||
                !r.draftComment
            );
        })
        .map((mr) => mr.iid);
}

// ─── rendering ─────────────────────────────────────────────────────────────────

interface RenderContext {
    authors: Map<string, AuthorFacts>;
    urlTemplate: string | null;
}

function mrLink(mr: StaleMr): string {
    return `[!${mr.iid}](${mr.webUrl})`;
}

function adoUrlOf(mr: StaleMr, urlTemplate: string | null): string | null {
    if (!mr.ado) {
        return null;
    }

    return mr.ado.item?.url ?? workItemUrl({ urlTemplate }, mr.ado.id);
}

function titleCell(mr: StaleMr, urlTemplate: string | null, max = 70): string {
    const raw = mr.title.length <= max ? mr.title : `${mr.title.slice(0, max - 3)}...`;
    const text = markdownCell(raw).replaceAll("[", "\\[").replaceAll("]", "\\]") + (mr.draft ? " (draft)" : "");
    const url = adoUrlOf(mr, urlTemplate);

    return url ? `[${text}](${url})` : text;
}

function adoLink(item: AdoWorkItem): string {
    return `[${item.id} ${markdownCell(item.title)}](${item.url})`;
}

function adoIdLink(id: number, urlTemplate: string | null): string {
    const url = workItemUrl({ urlTemplate }, id);

    return url ? `[${id}](${url})` : String(id);
}

function adoStateCell(mr: StaleMr): string {
    if (!mr.ado) {
        return "no id";
    }

    if (mr.ado.error || !mr.ado.item || !mr.ado.effective) {
        return `unreadable (${mr.ado.id})`;
    }

    const { item, effective } = mr.ado;
    if (effective.id === item.id) {
        return `${item.type}: ${item.state}`;
    }

    return `Task: ${item.state}; parent ${effective.type} [${effective.id}](${effective.url}): ${effective.state}`;
}

function behindAhead(mr: StaleMr): string {
    if (mr.git.targetMissing) {
        return "target missing";
    }

    if (mr.git.sourceMissing) {
        return "source missing";
    }

    return `${mr.git.behind} / ${mr.git.ahead}`;
}

function shippedCell(mr: StaleMr): string {
    const s = mr.shipped;
    if (!s) {
        return "not checked (branch missing)";
    }

    const stat = `${s.filesChanged} files, +${s.insertions} -${s.deletions}`;
    if (s.verdict === "unknown") {
        return `unknown (${s.note ?? "no sampled lines"}); ${stat}`;
    }

    const perRef = s.refs
        .map((r) => `${r.ref.replace(/^origin\//, "")} ${r.verdict} ${r.matched}/${r.sampled}`)
        .join(", ");

    return `**${s.verdict}** (${perRef}); ${stat}`;
}

function lastActivity(mr: StaleMr): string {
    const note = mr.lastNote;
    if (!note) {
        return formatDate(mr.updatedAt);
    }

    return `${formatDate(mr.updatedAt)} (note ${formatDate(note.updatedAt)} by ${note.author}, ${note.system ? "system" : "human"})`;
}

function recommendationCell(mr: StaleMr): string {
    const r = mr.review;
    if (!mr.needsReview) {
        return "not reviewed (young)";
    }

    if (!r.recommendation) {
        return "UNFILLED";
    }

    return r.confidence === null ? r.recommendation : `${r.recommendation} (${r.confidence} %)`;
}

function fullTable(rows: StaleMr[], ctx: RenderContext): string {
    const header =
        "| MR | Title (link = work item) | ADO state | Author | Target | Created | Age (d) | Last commit on branch | Behind / ahead | Conflicts | Last MR activity | Author last commit | Author last GitLab event | Recommendation |\n|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|";
    const body = rows.map((mr) => {
        const a = ctx.authors.get(mr.author.username);

        return `| ${mrLink(mr)} | ${titleCell(mr, ctx.urlTemplate)} | ${adoStateCell(mr)} | ${mr.author.username} | ${mr.targetBranch} | ${formatDate(mr.createdAt)} | ${mr.ageDays} | ${formatDate(mr.git.lastCommitDate)} | ${behindAhead(mr)} | ${mr.hasConflicts ? "yes" : "no"} | ${lastActivity(mr)} | ${formatDate(a?.lastCommitDate)} | ${a?.lastGitlabEvent ? formatDate(a.lastGitlabEvent) : `none (${a?.gitlabState ?? "unknown"})`} | ${recommendationCell(mr)} |`;
    });

    return [header, ...body].join("\n");
}

function compactTable(rows: StaleMr[], ctx: RenderContext): string {
    const header =
        "| MR | Title (link = work item) | ADO state | Author | Target | Created | Age (d) | Behind / ahead | Conflicts | Updated |\n|---|---|---|---|---|---|---:|---|---|---|";
    const body = rows.map(
        (mr) =>
            `| ${mrLink(mr)} | ${titleCell(mr, ctx.urlTemplate)} | ${adoStateCell(mr)} | ${mr.author.username} | ${mr.targetBranch} | ${formatDate(mr.createdAt)} | ${mr.ageDays} | ${behindAhead(mr)} | ${mr.hasConflicts ? "yes" : "no"} | ${formatDate(mr.updatedAt)} |`
    );

    return [header, ...body].join("\n");
}

function commentBullets(item: AdoWorkItem, limit = 5): string[] {
    return item.comments
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit)
        .map((c) => `    - ${formatDate(c.date)} ${c.author}: ${c.text.replace(/\s+/g, " ").slice(0, 240)}`);
}

function prSection(mr: StaleMr, ctx: RenderContext): string {
    const a = ctx.authors.get(mr.author.username);
    const lines: string[] = [`### ${mrLink(mr)} ${markdownCell(mr.title)}`, ""];
    lines.push(
        `- MR: [!${mr.iid} ${markdownCell(mr.title)}](${mr.webUrl})${mr.draft ? " (draft)" : ""}, ${mr.author.username}, \`${mr.sourceBranch}\` -> \`${mr.targetBranch}\``
    );
    if (!mr.ado) {
        lines.push("- ADO: no work-item id in the title, branch or description");
    } else if (mr.ado.error || !mr.ado.item) {
        lines.push(
            `- ADO: ${adoIdLink(mr.ado.id, ctx.urlTemplate)} unreadable: ${mr.ado.error?.error ?? "unknown error"}`
        );
    } else {
        const { item, effective } = mr.ado;
        lines.push(
            `- ADO ${item.type}: ${adoLink(item)}, state **${item.state}**${item.assignee ? `, assignee ${item.assignee}` : ""}`
        );
        if (effective && effective.id !== item.id) {
            lines.push(`- Corrected to parent ${effective.type}: ${adoLink(effective)}, state **${effective.state}**`);
        } else if (mr.ado.parentError) {
            lines.push(`- Parent ${item.parentId} unreadable: ${mr.ado.parentError.error}`);
        }

        const target = effective ?? item;
        lines.push(
            `- ADO last activity: ${formatDate(target.changed)} by ${target.changedBy ?? "unknown"}; last comment ${target.lastCommentDate ? formatDate(target.lastCommentDate) : "none"}`
        );
    }

    for (const extra of mr.adoExtra ?? []) {
        const item = extra.effective ?? extra.item;
        lines.push(
            item
                ? `- Also names ADO ${item.type}: ${adoLink(item)}, state **${item.state}**`
                : `- Also names ADO ${adoIdLink(extra.id, ctx.urlTemplate)} unreadable: ${extra.error?.error ?? "unknown error"}`
        );
    }

    lines.push(
        `- How behind: ${behindAhead(mr)} commits, conflicts ${mr.hasConflicts ? "yes" : "no"}, merge status \`${mr.detailedMergeStatus}\`; last commit on branch ${formatDate(mr.git.lastCommitDate)}`
    );
    lines.push(`- Shipped: ${shippedCell(mr)}`);
    if (mr.closedBug) {
        lines.push(
            `- Closed bug, open MR: ${closedBugSummary(mr.closedBug)}${FIX_LOCATIONS_TO_REPORT.includes(mr.closedBug.fix) ? " **(fix not released)**" : ""}`
        );
    }

    if (mr.sideComments?.length) {
        lines.push(
            `- Side texts of ours: ${mr.sideComments
                .map(
                    (c) =>
                        `${c.key} ${c.postedNoteUrl ? `[posted ${formatDate(c.postedAt)}](${c.postedNoteUrl})` : c.draftNoteId ? `draft ${c.draftNoteId}` : "pending"}`
                )
                .join("; ")}`
        );
    }

    for (const conflict of mr.labelConflicts ?? []) {
        lines.push(`- Label conflict: ${markdownCell(conflict)}`);
    }

    lines.push(
        `- Approvals: ${mr.approvals ? (mr.approvals.approvedBy.length ? mr.approvals.approvedBy.join(", ") : "none") : "unknown"}`
    );
    if (mr.siblings?.length) {
        lines.push(
            `- Related MRs: ${mr.siblings.map((s) => `[!${s.iid}](${s.webUrl}) ${s.state}, ${s.relation.replaceAll("-", " ")}, updated ${formatDate(s.updatedAt)}`).join("; ")}`
        );
    }

    lines.push(
        `- Last MR activity: ${lastActivity(mr)}${mr.lastHumanNote ? `; last human note ${formatDate(mr.lastHumanNote.updatedAt)} by ${mr.lastHumanNote.author}` : ""}`
    );
    const humanNotes = (mr.notes ?? []).filter((n) => !n.system).slice(0, 3);
    if (humanNotes.length) {
        lines.push(`- Recent human notes (${(mr.notes ?? []).filter((n) => !n.system).length} kept):`);
        lines.push(
            ...humanNotes.map(
                (n) =>
                    `    - ${formatDate(n.createdAt)} ${n.author}: ${markdownCell(n.body.replace(/\s+/g, " ").slice(0, 240))}`
            )
        );
    }

    lines.push(
        `- Author: last commit ${formatDate(a?.lastCommitDate) || "unknown"}, last GitLab event ${a?.lastGitlabEvent ? formatDate(a.lastGitlabEvent) : "none"}, account ${a?.gitlabState ?? "unknown"}`
    );
    lines.push(
        `- Recommended action: **${mr.review.recommendation ?? "UNFILLED"}**${mr.review.confidence === null ? "" : ` (${mr.review.confidence} % confidence)`}`
    );
    lines.push(`- Why: ${mr.review.reason ?? "UNFILLED"}`);
    if (mr.review.evidence?.length) {
        lines.push(`- Evidence pulled by the reviewer: ${mr.review.evidence.map((e) => `\`${e}\``).join(", ")}`);
    }

    const target = mr.ado?.effective ?? mr.ado?.item ?? null;
    if (target && target.comments.length > 0) {
        lines.push(
            `- What the comments say in the ADO (${target.comments.length} on ${target.id}): ${mr.review.adoCommentsSummary ?? "UNFILLED"}`
        );
        lines.push(...commentBullets(target));
    } else {
        lines.push("- What the comments say in the ADO: no comments");
    }

    if (mr.review.labels?.length) {
        lines.push(`- Labels: ${mr.review.labels.map((l) => `${l.type} \`${l.label}\``).join(", ")}`);
    }

    if (mr.review.labelsAppliedAt) {
        lines.push(
            `- Labels applied ${formatDate(mr.review.labelsAppliedAt)}: ${(mr.review.labelsBefore ?? []).join(", ") || "(none)"} to ${(mr.review.labelsAfter ?? []).join(", ") || "(none)"}`
        );
    }

    if (mr.review.postedNoteUrl) {
        lines.push(`- Posted ${formatDate(mr.review.postedAt)}: ${mr.review.postedNoteUrl}`);
    }

    lines.push("- Drafted MR comment:", "", "```", mr.review.draftComment ?? "UNFILLED", "```");

    return lines.join("\n");
}

export interface RenderOptions {
    createdAt: string;
    adoTags: number[];
    title?: string;
    /** `workItems.urlTemplate`, to link work items that could not be read. */
    workItemUrlTemplate?: string | null;
}

export function renderStaleReport(report: StaleReport, options: RenderOptions): string {
    const ctx: RenderContext = {
        authors: new Map(report.authors.map((a) => [a.username, a])),
        urlTemplate: options.workItemUrlTemplate ?? null,
    };
    const mrs = report.mrs;
    const inBucket = (lo: number, hi: number) => mrs.filter((m) => m.ageDays >= lo && m.ageDays < hi).length;
    const rec = (r: Recommendation) => mrs.filter((m) => m.review.recommendation === r).length;
    const adoOf = (m: StaleMr) => m.ado?.effective ?? m.ado?.item;
    const summary: Array<[string, number | string]> = [
        ["Total open", mrs.length],
        ["Older than 365 d", inBucket(366, Number.POSITIVE_INFINITY)],
        ["180 to 365 d", inBucket(181, 366)],
        ["90 to 180 d", inBucket(91, 181)],
        ["30 to 90 d", inBucket(31, 91)],
        ["Younger than 30 d", inBucket(0, 31)],
        ["Drafts", mrs.filter((m) => m.draft).length],
        ["With conflicts", mrs.filter((m) => m.hasConflicts).length],
        ["Source branch missing on origin", mrs.filter((m) => m.git.sourceMissing).length],
        ["Target branch missing on origin", mrs.filter((m) => m.git.targetMissing).length],
        ["More than 500 commits behind target", mrs.filter((m) => (m.git.behind ?? 0) > 500).length],
        ["Without a recognizable work-item id", mrs.filter((m) => !m.ado).length],
        ["Work item unreadable", mrs.filter((m) => m.ado?.error).length],
        ["Work item Closed", mrs.filter((m) => adoOf(m)?.state === "Closed").length],
        [
            "Branch content already on a target ref (shipped present)",
            mrs.filter((m) => m.shipped?.verdict === "present").length,
        ],
        ["Branch content on no target ref (shipped absent)", mrs.filter((m) => m.shipped?.verdict === "absent").length],
        [
            "Work item Closed but content absent everywhere",
            mrs.filter((m) => adoOf(m)?.state === "Closed" && m.shipped?.verdict === "absent").length,
        ],
        [
            "Closed bug, open MR, fix not on UAT or production (closed-bug)",
            mrs.filter((m) => m.closedBug && FIX_LOCATIONS_TO_REPORT.includes(m.closedBug.fix)).length,
        ],
        ["Label contradicted by the content check", mrs.filter((m) => m.labelConflicts?.length).length],
        ["Approved by someone", mrs.filter((m) => m.approvals?.approvedBy.length).length],
        [`Reviewed (older than ${report.reviewMinAgeDays} d)`, mrs.filter((m) => m.needsReview).length],
        ...RECOMMENDATIONS.map((r): [string, number] => [`Recommended ${r}`, rec(r)]),
    ];
    const veryOld = mrs.filter((m) => m.ageDays > 180);
    const mid = mrs.filter((m) => m.ageDays > 90 && m.ageDays <= 180);
    const young = mrs.filter((m) => m.ageDays <= 90);
    const reviewed = mrs.filter((m) => m.needsReview);
    const title = options.title ?? `Open merge requests in ${report.project}`;
    const sections: string[] = [];
    sections.push(
        `---\ntitle: ${title}\ncreated: ${options.createdAt}\ntags:\n  - gitlab\n  - merge-requests\n  - cleanup\nado: [${options.adoTags.join(", ")}]\n---`
    );
    sections.push(
        `# ${title}\n\nState as of ${options.createdAt}. Read-only sweep of every open MR in \`${report.project}\`, generated by \`tools gitlab stale-branches\` from \`${report.repoRoot}\`. Nothing was closed, commented or pushed. Dates are ${getDateStyle() === "dmy" ? "d.m.YYYY" : "YYYY-MM-DD"}.`
    );
    sections.push(
        `## Summary\n\n| Metric | Count |\n|---|---:|\n${summary.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}`
    );
    sections.push(
        [
            "## How to read the tables",
            "",
            `- Age counts from the MR creation date to ${formatDate(report.asOfDate)}.`,
            "- ADO state: the work item found by its id in the MR title, then the branch name, then the description. When that item is a Task, the parent story, bug or feature is shown too, because the parent carries the business state.",
            `- Author activity: last commit in this repo across every identity seen on the author's MR branches, plus the newest GitLab event of the account. An account without an event for ${report.inactiveAfterDays} days, or not in state active, counts as inactive.`,
            `- Shipped: a content check, not a history check. The lines the branch adds are sampled and searched in ${(report.shippedRefs ?? []).map((r) => `\`${r}\``).join(", ")}. \`present\` means more than 80 % of the sampled lines are in that ref, \`absent\` means none is. Ancestry is not used, because squash merges, rebases and rewritten history defeat it. A Closed work item with \`absent\` everywhere means the fix is gone, not shipped.`,
            "- Labels on an MR are claims by people. A label conflict line means the content check says the opposite.",
            "- Closed bug, open MR: the work item is a Closed Bug and the line says where the MR content is (`released` on UAT or production, `unreleased` on the test environment only, `partial`, `nowhere`, `unknown`). `unreleased` means the bug was closed after a test and the fix never reached UAT or production; the `closed-bug` comment reports it.",
            `- Recommendation, confidence, reason, comment summary and drafted comment come from the review pass over the filled JSON, one MR at a time, for every MR older than ${report.reviewMinAgeDays} days. CLOSE, ASK AUTHOR, REBASE-NEEDED and KEEP are the only values.`,
        ].join("\n")
    );
    sections.push(
        `## Very old MRs (older than 180 days)\n\n${veryOld.length} MRs, oldest first.\n\n${fullTable(veryOld, ctx)}`
    );
    sections.push(`## 90 to 180 days\n\n${mid.length} MRs, oldest first.\n\n${fullTable(mid, ctx)}`);
    sections.push(`## Younger than 90 days\n\n${young.length} MRs, oldest first.\n\n${compactTable(young, ctx)}`);
    sections.push(
        `## MR by MR (older than ${report.reviewMinAgeDays} days)\n\n${reviewed.length} MRs, oldest first.\n\n${reviewed.map((mr) => prSection(mr, ctx)).join("\n\n")}`
    );
    sections.push(
        `## Per author\n\n| Author | GitLab state | Open MRs | Oldest MR age (d) | Oldest MR | Last commit in repo | Last GitLab event | Git identities on their branches |\n|---|---|---:|---:|---|---|---|---|\n${report.authors
            .map((a) => {
                const oldest = mrs.find((m) => m.iid === a.oldestMrIid);

                return `| ${a.username} | ${a.gitlabState} | ${a.openMrs} | ${a.oldestMrAgeDays} | ${oldest ? mrLink(oldest) : a.oldestMrIid} | ${formatDate(a.lastCommitDate)} | ${a.lastGitlabEvent ? formatDate(a.lastGitlabEvent) : "none"} | ${markdownCell(a.gitIdentities.join(", "))} |`;
            })
            .join("\n")}`
    );
    sections.push(
        `## Commands and failures\n\nCommands run by \`tools gitlab stale-branches preflight\`:\n\n\`\`\`\n${report.commands.join("\n")}\n\`\`\`\n\n${
            report.failures.length
                ? `Failures, verbatim:\n\n${report.failures.map((f) => `- ${markdownCell(f)}`).join("\n")}`
                : "No failures."
        }`
    );

    return `${sections.join("\n\n")}\n`;
}
