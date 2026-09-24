/**
 * Closed bug, open MR. A tester closes the work item after a test on the test environment and
 * the MR that carries the fix stays open, so the fix never reaches UAT or production. The
 * content check says where the fix actually is; the comment of this type states it and asks for
 * a merge or a reason.
 */

import { formatDate } from "@app/gitlab/lib/dates";
import type { Messages } from "@app/gitlab/lib/messages";
import { PRESENT_RATIO, type ShippedFacts, type ShippedRoles } from "@app/gitlab/lib/shipped";
import type { AdoFacts } from "@app/gitlab/lib/stale-branches";
import type { AdoWorkItem } from "@app/gitlab/lib/work-items";

export const CLOSED_BUG_KEY = "closedBug";
export const CLOSED_BUG_TYPES = ["Bug"];

/** Where the MR's content is, by the content check. */
export type FixLocation = "released" | "unreleased" | "partial" | "nowhere" | "unknown";

/** Verdicts worth a comment: the fix is not (fully) on UAT or production although the bug is Closed. */
export const FIX_LOCATIONS_TO_REPORT: FixLocation[] = ["unreleased", "partial", "nowhere"];

export interface RefShare {
    ref: string;
    matched: number;
    sampled: number;
    /** matched / sampled, null when nothing was sampled. */
    ratio: number | null;
}

export interface ClosedBugFacts {
    adoId: number;
    type: string;
    title: string;
    url: string;
    closedDate: string | null;
    closedBy: string | null;
    reason: string | null;
    environment: string | null;
    mergeRequestUrl: string | null;
    fix: FixLocation;
    uat: RefShare | null;
    production: RefShare | null;
    test: RefShare | null;
    exhaustive: boolean;
    /** True for a diff too large for a content check to mean anything (a stacked or codemod branch). */
    huge: boolean;
    /** Files with lines missing on the release target (UAT, else production), most missing first; exhaustive checks only. */
    missingFiles: Array<{ path: string; missing: number; total: number }>;
    /** The text `closed-bug` would send for these facts, so the drafting agent sees it next to `review`. */
    comment: string;
}

/** What the texts need beyond the facts: which ref is which environment, the language, and the project. */
export interface ClosedBugContext {
    roles: ShippedRoles;
    messages: Messages;
    /** `group/name`, so a work item naming an MR of this project is recognised. */
    projectPath: string;
    types?: string[];
}

/** More than this share of the comparable lines on a ref means part of the change is there. */
const ON_REF_RATIO = 0.2;
/** At least this share on the test environment means the fix was merged for testing. */
const ON_TEST_RATIO = 0.5;
/** Above this many changed files the diff is a stack or a codemod, not one fix; the location is `unknown`. */
const HUGE_FILES = 300;

function share(shipped: ShippedFacts | null, ref: string | null): RefShare | null {
    const check = ref ? shipped?.refs.find((r) => r.ref === ref) : undefined;
    if (!check) {
        return null;
    }

    return {
        ref: check.ref,
        matched: check.matched,
        sampled: check.sampled,
        ratio: check.sampled ? check.matched / check.sampled : null,
    };
}

const ratioOf = (r: RefShare | null) => r?.ratio ?? 0;

const shortRef = (ref: string | null): string | null => (ref ? ref.replace(/^origin\//, "") : null);

/** The ref a fix has to reach: UAT when there is one, else production. */
export function releaseTarget(roles: ShippedRoles): string | null {
    return roles.uat ?? roles.production;
}

export function fixLocation(shipped: ShippedFacts | null, roles: ShippedRoles): FixLocation {
    const uat = share(shipped, roles.uat);
    const production = share(shipped, roles.production);
    const test = share(shipped, roles.test);
    if (![uat, production, test].some((r) => r && r.ratio !== null)) {
        return "unknown";
    }

    if (ratioOf(uat) > PRESENT_RATIO || ratioOf(production) > PRESENT_RATIO) {
        return "released";
    }

    if (ratioOf(uat) > ON_REF_RATIO || ratioOf(production) > ON_REF_RATIO) {
        return "partial";
    }

    if (ratioOf(test) >= ON_TEST_RATIO) {
        return "unreleased";
    }

    return ratioOf(test) <= ON_REF_RATIO ? "nowhere" : "partial";
}

function missingOn(shipped: ShippedFacts | null, ref: string | null): ClosedBugFacts["missingFiles"] {
    if (!shipped?.exhaustive || !share(shipped, ref) || !ref) {
        return [];
    }

    return shipped.files
        .map((f) => ({
            path: f.path,
            missing: f.lines.filter((l) => !l.in.includes(ref)).length,
            total: f.lines.length,
        }))
        .filter((f) => f.missing > 0)
        .sort((a, b) => b.missing - a.missing);
}

/** The facts for one Closed work item and the MR's content check. */
export function closedBugFacts(options: {
    item: AdoWorkItem;
    shipped: ShippedFacts | null;
    iid?: number;
    context: ClosedBugContext;
}): ClosedBugFacts {
    const { item, shipped, context } = options;
    const huge = (shipped?.filesChanged ?? 0) > HUGE_FILES;
    const facts: Omit<ClosedBugFacts, "comment"> = {
        adoId: item.id,
        type: item.type,
        title: item.title,
        url: item.url,
        closedDate: item.closedDate ?? null,
        closedBy: item.closedBy ?? null,
        reason: item.reason ?? null,
        environment: item.environment ?? null,
        mergeRequestUrl: item.mergeRequestUrl ?? null,
        fix: huge ? "unknown" : fixLocation(shipped, context.roles),
        uat: share(shipped, context.roles.uat),
        production: share(shipped, context.roles.production),
        test: share(shipped, context.roles.test),
        exhaustive: shipped?.exhaustive === true,
        huge,
        missingFiles: huge ? [] : missingOn(shipped, releaseTarget(context.roles)),
    };

    return { ...facts, comment: closedBugComment({ facts, shipped, iid: options.iid, context }) };
}

/**
 * The check for one MR of the sweep: its work item (the parent for a Task) is Closed and of a
 * bug-like type. Null otherwise, and null when the MR has no readable item.
 */
export function closedBugOf(
    mr: { ado: AdoFacts | null; shipped: ShippedFacts | null; iid?: number },
    context: ClosedBugContext
): ClosedBugFacts | null {
    const item = mr.ado?.effective ?? mr.ado?.item ?? null;
    if (item?.state !== "Closed" || !(context.types ?? CLOSED_BUG_TYPES).includes(item.type)) {
        return null;
    }

    return closedBugFacts({ item, shipped: mr.shipped, iid: mr.iid, context });
}

function pct(r: RefShare | null, messages: Messages): string {
    return r?.ratio === null || r?.ratio === undefined
        ? "?"
        : messages.text("closedBug.percent", { value: Math.round(100 * r.ratio) });
}

/** The code bullet: raw MR size, then the comparable lines per environment. */
export function closedBugCodeLine(
    facts: Omit<ClosedBugFacts, "comment">,
    shipped: ShippedFacts | null,
    context: ClosedBugContext
): string {
    const m = context.messages;

    if (shipped && facts.huge) {
        return m.text("closedBug.codeHuge", {
            files: m.count(shipped.filesChanged, "file"),
            insertions: shipped.insertions,
        });
    }

    if (!shipped || facts.fix === "unknown") {
        return m.text("closedBug.codeUnknown");
    }

    const size = m.text("closedBug.size", {
        lines: m.count(shipped.insertions, "line"),
        files: m.count(shipped.filesChanged, "file"),
    });
    const comparable = Math.max(facts.uat?.sampled ?? 0, facts.production?.sampled ?? 0, facts.test?.sampled ?? 0);
    const roles = context.roles;
    const parts = [
        roles.uat
            ? m.text("closedBug.partUat", {
                  ref: shortRef(roles.uat) ?? "",
                  matched: facts.uat?.matched ?? 0,
                  pct: pct(facts.uat, m),
              })
            : null,
        facts.production
            ? m.text("closedBug.partProduction", {
                  ref: shortRef(facts.production.ref) ?? "",
                  matched: facts.production.matched,
                  pct: pct(facts.production, m),
              })
            : null,
        roles.test
            ? m.text("closedBug.partTest", {
                  ref: shortRef(roles.test) ?? "",
                  matched: facts.test?.matched ?? 0,
                  pct: pct(facts.test, m),
              })
            : null,
    ].filter((p): p is string => p !== null);
    const missing =
        facts.fix === "partial" && facts.missingFiles.length
            ? m.text("closedBug.missing", {
                  ref: shortRef(releaseTarget(roles)) ?? "",
                  files: facts.missingFiles
                      .slice(0, 3)
                      .map((f) => `${f.path.split("/").pop()} (${f.missing}/${f.total})`)
                      .join(", "),
                  more:
                      facts.missingFiles.length > 3
                          ? m.text("closedBug.missingMore", { count: facts.missingFiles.length - 3 })
                          : "",
              })
            : "";

    return m.text("closedBug.code", {
        size,
        comparable,
        sample: facts.exhaustive ? "" : m.text("closedBug.sample"),
        parts: parts.join(", "),
        missing,
    });
}

/** The ask, with a confidence badge; lower by ten points when the check was a sample. */
export function closedBugAsk(facts: Omit<ClosedBugFacts, "comment">, context: ClosedBugContext): string {
    const m = context.messages;
    const roles = context.roles;
    const vars = (n: number) => ({
        badge: `[${facts.exhaustive ? n : n - 10}%]`,
        environment: facts.environment ? m.text("closedBug.environment", { environment: facts.environment }) : "",
        test: shortRef(roles.test) ?? "?",
        release: shortRef(releaseTarget(roles)) ?? "?",
        refs: [roles.uat, roles.production, roles.test]
            .map(shortRef)
            .filter((r): r is string => r !== null)
            .join(", "),
    });

    switch (facts.fix) {
        case "unreleased":
            return m.text("closedBug.askUnreleased", vars(90));
        case "nowhere":
            return m.text("closedBug.askNowhere", vars(85));
        case "partial":
            return m.text("closedBug.askPartial", vars(80));
        case "released":
            return m.text("closedBug.askReleased", vars(90));
        default:
            return m.text("closedBug.askUnknown");
    }
}

/**
 * The comment of this type, one short block: the lead sentence with the work item, the code
 * bullet and the ask. The same text stands alone or appended to the sweep comment.
 */
export function closedBugComment(options: {
    facts: Omit<ClosedBugFacts, "comment">;
    shipped: ShippedFacts | null;
    iid?: number;
    context: ClosedBugContext;
}): string {
    const { facts, shipped, iid, context } = options;
    const m = context.messages;
    const closed = [facts.closedDate ? formatDate(facts.closedDate) : null, facts.closedBy].filter(Boolean).join(", ");
    const lead = m.text("closedBug.lead", {
        type: facts.type,
        id: facts.adoId,
        title: facts.title,
        url: facts.url,
        closed: closed ? ` (${closed})` : "",
    });
    const lines = [lead, closedBugCodeLine(facts, shipped, context)];
    const ownProject = facts.mergeRequestUrl?.includes(`/${context.projectPath}/-/merge_requests/`) ?? false;
    const linkedIid = ownProject ? Number(facts.mergeRequestUrl?.match(/\/merge_requests\/(\d+)/)?.[1] ?? 0) : 0;

    if (linkedIid && linkedIid === iid) {
        lines.push(m.text("closedBug.linkedThis"));
    } else if (linkedIid) {
        lines.push(m.text("closedBug.linkedOther", { iid: linkedIid }));
    } else if (facts.mergeRequestUrl) {
        lines.push(m.text("closedBug.linkedUrl", { url: facts.mergeRequestUrl }));
    }

    lines.push(closedBugAsk(facts, context));

    return lines.join("\n");
}

/** One row per MR for the CLI table and the note. */
export function closedBugSummary(facts: ClosedBugFacts): string {
    const refs = [facts.uat, facts.production, facts.test]
        .filter((r): r is RefShare => r !== null)
        .map((r) => `${shortRef(r.ref)} ${r.matched}/${r.sampled}`)
        .join(", ");

    return `${facts.fix}${facts.huge ? " (huge diff)" : ""}${facts.exhaustive ? "" : " (sample)"}; ${refs}; Closed ${facts.closedDate ? formatDate(facts.closedDate) : "?"}${facts.closedBy ? ` by ${facts.closedBy}` : ""}`;
}
