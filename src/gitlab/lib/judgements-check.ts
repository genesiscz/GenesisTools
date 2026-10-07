/**
 * `review skeleton` writes the judgements file with every item's heading pre-filled; `review check`
 * proves a filled one is complete and safe to render and post: known ids whose pair still matches the
 * MR, a verdict with a badge, an action the item allows with the text it sends, an anchor whose line
 * text is really at that line, and the house rules for draft text (from the config).
 */

import type { DraftRules } from "@app/gitlab/lib/config";
import {
    ACTIONS,
    actionTextField,
    badgeOf,
    isUnfilled as isBlank,
    type JudgementItem,
    type Judgements,
    type JudgementsJson,
    judgementsToJson,
    parseAnchor,
    parseJudgements,
    verdictOf,
} from "@app/gitlab/lib/judgements";
import type { DiffFile } from "@app/gitlab/lib/pr-review";

/** One item the skeleton offers and the check knows, as the MR has it now. */
export interface KnownItem {
    id: string;
    kind: "T" | "Y" | "D";
    /** `discussion <full id>` or `draft <id>`. */
    pair: { kind: "discussion" | "draft"; value: string };
    path: string | null;
    line: number | null;
    /** The first note or the draft body, for the skeleton's title hint. */
    body: string;
    /** For T and Y: who started the thread. */
    author: string;
    /** A D item whose draft was published: the draft id its heading still names. */
    publishedFrom?: string;
}

export interface SkeletonInput {
    iid: number;
    mode: "receive" | "give";
    headSha: string;
    items: KnownItem[];
}

const flat = (text: string, max: number): string => {
    const one = text.replace(/\s+/g, " ").trim();

    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function pairText(item: KnownItem): string {
    return item.pair.kind === "discussion" ? `discussion ${item.pair.value.slice(0, 12)}` : `draft ${item.pair.value}`;
}

function anchorText(item: KnownItem): string {
    return item.path ? `${item.path}:${item.line ?? 1}` : "top-level";
}

function threadBlock(item: KnownItem): string[] {
    return [
        `# ${item.id} ${flat(item.body, 60)} · ${pairText(item)} · ${anchorText(item)}`,
        "- Verdict: ",
        "- Proposal: ",
        "- Rationale:",
        "  - ",
        `- Action: ${ACTIONS[item.kind].join(" | ")}`,
        "- Proposed draft reply:",
        "",
        "```markdown",
        "```",
        "",
    ];
}

function ownCommentBlock(item: KnownItem): string[] {
    return [
        `# ${item.id} ${flat(item.body, 60)} · ${pairText(item)} · ${anchorText(item)}`,
        "- Verdict on the comment: ",
        "- Answer to the comment: ",
        "- Rationale:",
        "  - ",
        "- 💡 Suggestion: ",
        `- Action: ${ACTIONS[item.kind].join(" | ")}`,
        ...(item.kind === "D" ? ["- Move to: ", "- Proposed rewording:", "", "```markdown", "```", ""] : []),
        "- Proposed answer:",
        "",
        "```markdown",
        "```",
        "",
    ];
}

const NEW_FINDING = [
    "# N01 <short title of the concern>",
    "- Severity: 🛑 blocker | ⚠️ should fix | ❓ question | nit",
    "- Anchor: <path>:<line> (new) `<the text of that line, copied from the facts>`",
    "- Verdict: ",
    "- Proposal: Post anchored draft | Post top-level note | Tell the user only | Skip",
    "- Rationale:",
    "  - ",
    "- Action: comment | none",
    "- Proposed draft comment:",
    "",
    "```markdown",
    "```",
    "",
];

/** The judgements file for one MR, every known item's heading pre-filled. */
export function skeletonText(input: SkeletonInput): string {
    const lines = [
        `# MR !${input.iid} · ${input.mode} · head ${input.headSha.slice(0, 10)}`,
        input.mode === "give"
            ? "- Overall: Approve | Approve with comments | Changes requested | Blocked (question)"
            : "- Overall: ",
        "",
    ];

    for (const item of input.items) {
        lines.push(...(item.kind === "T" ? threadBlock(item) : ownCommentBlock(item)));
    }

    if (input.mode === "give") {
        lines.push(
            "<!-- New findings: copy this block per finding as N01, N02, … and delete it when there is none. -->",
            ...NEW_FINDING
        );
    }

    lines.push(
        "# Checked and fine",
        "",
        "- ",
        "",
        "# Considered, not worth a comment",
        "",
        "- ",
        "",
        ...(input.mode === "give" ? ["# Gates", "", "| Gate | Exit code |", "|---|---|", ""] : []),
        "# Decisions",
        "",
        ""
    );

    return lines.join("\n");
}

/** The skeleton in JSON: the same items; each `Action` lists its choices until it is filled. */
export function skeletonJson(input: SkeletonInput): JudgementsJson {
    const json = judgementsToJson(parseJudgements(skeletonText(input)), {
        mr: input.iid,
        mode: input.mode,
        head: input.headSha.slice(0, 10),
    });

    return {
        ...json,
        overall: "",
        items: json.items.map((item) => ({
            ...item,
            fields: { ...item.fields, Action: ACTIONS[item.id[0] as keyof typeof ACTIONS].join(" | ") },
        })),
    };
}

// ─── check ─────────────────────────────────────────────────────────────────────

export interface CheckProblem {
    id: string;
    line: number;
    message: string;
}

export interface CheckResult {
    errors: CheckProblem[];
    /** Items left unjudged and other things worth a look; they do not fail the check. */
    warnings: CheckProblem[];
}

export interface CheckInput {
    judgements: Judgements;
    known: KnownItem[];
    /** The MR diff, for new findings' anchors; null in receive mode. */
    files: DiffFile[] | null;
    rules: DraftRules;
    /** The MR the command targets; a file written for another MR is refused as a whole. */
    iid?: number;
}

/** A text to be posted is empty only when it has no text: a ` | ` in it is a table or prose, not a placeholder. */
function isEmptyText(value: string | undefined): boolean {
    return value === undefined || value.trim() === "";
}

/** The text at `line` of `side` in the diff, or null when the line is outside every hunk. */
function lineAt(file: DiffFile, line: number, side: "new" | "old"): string | null {
    for (const hunk of file.hunks) {
        for (const candidate of hunk.lines) {
            if ((side === "new" ? candidate.newLine : candidate.oldLine) === line) {
                return candidate.text;
            }
        }
    }

    return null;
}

/** Lines on `side` whose text is `text`, for a "did you mean" hint. */
function linesWithText(file: DiffFile, text: string, side: "new" | "old"): number[] {
    return file.hunks
        .flatMap((hunk) => hunk.lines)
        .filter((candidate) => candidate.text.trim() === text.trim())
        .map((candidate) => (side === "new" ? candidate.newLine : candidate.oldLine))
        .filter((line): line is number => line !== null);
}

function checkAnchor(item: JudgementItem, files: DiffFile[] | null, problems: CheckProblem[]): void {
    // The field the post uses: a move goes to `Move to`, whatever a leftover `Anchor` says.
    const value = item.fields.get(item.kind === "D" ? "Move to" : "Anchor");

    if (isBlank(value)) {
        problems.push({
            id: item.id,
            line: item.line,
            message: "an anchor is needed: `path:line (new) `text`` or `top`",
        });

        return;
    }

    const anchor = parseAnchor(value ?? "");

    if (typeof anchor === "string") {
        problems.push({ id: item.id, line: item.line, message: anchor });

        return;
    }

    if (anchor.top || !files) {
        return;
    }

    const file = files.find((candidate) => candidate.path === anchor.path || candidate.oldPath === anchor.path);

    if (!file) {
        problems.push({ id: item.id, line: item.line, message: `${anchor.path} is not in the MR diff` });

        return;
    }

    const found = lineAt(file, anchor.line, anchor.side);

    if (found === null) {
        problems.push({
            id: item.id,
            line: item.line,
            message: `${anchor.path}:${anchor.line} (${anchor.side}) is outside the diff GitLab shows; anchor on a line of a hunk`,
        });

        return;
    }

    if (anchor.text === null) {
        problems.push({
            id: item.id,
            line: item.line,
            message: `copy the line's text into the anchor: ${anchor.path}:${anchor.line} (${anchor.side}) \`${found.trim()}\``,
        });

        return;
    }

    if (found.trim() !== anchor.text.trim()) {
        const near = linesWithText(file, anchor.text, anchor.side);
        problems.push({
            id: item.id,
            line: item.line,
            message: `${anchor.path}:${anchor.line} (${anchor.side}) is \`${found.trim()}\`, not \`${anchor.text.trim()}\`${near.length > 0 ? `; that text is at line ${near.join(", ")}` : ""}`,
        });
    }
}

function wordPattern(word: string): RegExp {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

function lintText(item: JudgementItem, field: string, text: string, rules: DraftRules, problems: CheckProblem[]): void {
    const where = `${field}`;

    if (rules.forbidDashes && /[—–]/.test(text)) {
        problems.push({
            id: item.id,
            line: item.line,
            message: `${where}: no em or en dash; use a period, comma, colon or parentheses`,
        });
    }

    for (const banned of rules.bannedWords) {
        if (wordPattern(banned.word).test(text)) {
            problems.push({
                id: item.id,
                line: item.line,
                message: `${where}: "${banned.word}" is banned; write ${banned.instead}`,
            });
        }
    }

    if (/file:\/\/|\]\(\/(?!\/)/.test(text)) {
        problems.push({
            id: item.id,
            line: item.line,
            message: `${where}: no local file link in text that goes to the MR; name the path in backticks`,
        });
    }
}

/** Text answering inside a thread I started: the second person addresses nobody there. */
function ownThreadText(item: JudgementItem): Array<[string, string]> {
    if (item.kind !== "Y" && item.kind !== "D") {
        return [];
    }

    const answer = item.fences.get("Proposed answer");

    return answer ? [["Proposed answer", answer]] : [];
}

export function checkJudgements(input: CheckInput): CheckResult {
    const errors: CheckProblem[] = [];
    const warnings: CheckProblem[] = [];
    const known = new Map(input.known.map((item) => [item.id, item]));
    const seen = new Set<string>();

    for (const warning of input.judgements.warnings) {
        (warning.severity === "error" ? errors : warnings).push({
            id: warning.id,
            line: warning.line,
            message: warning.message,
        });
    }

    // An N item names no MR-owned id, so only the file's own MR keeps a copied file off this MR.
    if (input.iid !== undefined && input.judgements.mr !== undefined && input.judgements.mr !== input.iid) {
        errors.push({
            id: "file",
            line: 1,
            message: `this file was written for !${input.judgements.mr}, not !${input.iid}; run \`review skeleton\` for !${input.iid}`,
        });
    }

    for (const item of input.judgements.items) {
        if (seen.has(item.id)) {
            errors.push({ id: item.id, line: item.line, message: "this id appears twice; merge the two blocks" });
            continue;
        }

        seen.add(item.id);
        const verdict = verdictOf(item);

        if (isBlank(verdict)) {
            if (item.kind !== "N") {
                warnings.push({
                    id: item.id,
                    line: item.line,
                    message: "not judged (no verdict); it will be left out",
                });
            }

            continue;
        }

        if (item.kind !== "N") {
            const match = known.get(item.id);

            if (!match) {
                errors.push({
                    id: item.id,
                    line: item.line,
                    message: "no such item on this MR now; run `review skeleton` again",
                });
                continue;
            }

            if (!item.pair) {
                errors.push({
                    id: item.id,
                    line: item.line,
                    message: `the heading lost its \`${match.pair.kind} …\` pair, so nothing proves ${item.id} is the same item on this MR; run \`review skeleton\` again`,
                });
                continue;
            }

            // A published draft's heading still names the draft it was.
            const published = item.pair.kind === "draft" && match.publishedFrom !== undefined;
            const expectedKind = published ? "draft" : match.pair.kind;
            const expected = published ? (match.publishedFrom ?? "") : match.pair.value;
            // Discussion ids are shown shortened; a draft id is a number and must match exactly.
            const same =
                item.pair.kind === "draft" ? expected === item.pair.value : expected.startsWith(item.pair.value);

            if (item.pair.kind !== expectedKind || !same) {
                errors.push({
                    id: item.id,
                    line: item.line,
                    message: `the heading says ${item.pair.kind} ${item.pair.value}, but ${item.id} is ${match.pair.kind} ${match.pair.value.slice(0, 12)} now; run \`review skeleton\` again`,
                });
                continue;
            }
        }

        if (badgeOf(verdict) === null) {
            errors.push({
                id: item.id,
                line: item.line,
                message: "the verdict needs its confidence badge, e.g. `Valid [85%]`",
            });
        }

        const action = (item.fields.get("Action") ?? "").trim();
        const allowed = ACTIONS[item.kind];

        if (!allowed.includes(action)) {
            errors.push({
                id: item.id,
                line: item.line,
                message: `Action must be one of ${allowed.join(", ")}, got "${action}"`,
            });
            continue;
        }

        const textField = actionTextField(item.kind, action);

        // A move without a rewording keeps the draft's text, so only the other actions need theirs.
        if (textField && action !== "move" && isEmptyText(item.fences.get(textField))) {
            errors.push({
                id: item.id,
                line: item.line,
                message: `Action ${action} sends "${textField}"; it is empty`,
            });
        }

        if (item.kind === "N" && action === "comment") {
            checkAnchor(item, input.files, errors);
        }

        if (item.kind === "D" && action === "move") {
            checkAnchor(item, input.files, errors);
        }

        for (const [field, text] of item.fences) {
            lintText(item, field, text, input.rules, errors);
        }

        for (const [field, text] of ownThreadText(item)) {
            if (/^\s*(\[\d{1,3}%\]\s*)?opus:/i.test(text)) {
                errors.push({
                    id: item.id,
                    line: item.line,
                    message: `${field}: leave out "[NN%] Opus:"; the render and the post add it from the badge`,
                });
            }

            // A warning, not an error: a phrase list cannot tell a quote or a name from addressing nobody.
            for (const phrase of input.rules.ownThreadForbidden) {
                if (wordPattern(phrase).test(text)) {
                    warnings.push({
                        id: item.id,
                        line: item.line,
                        message: `${field}: "${phrase}" addresses nobody in your own thread; name the MR author or state it flat`,
                    });
                }
            }
        }
    }

    for (const item of input.known) {
        if (!seen.has(item.id) && item.kind === "T") {
            warnings.push({ id: item.id, line: 0, message: "this thread has no block in the file" });
        }
    }

    if (input.files) {
        warnings.push(...pathWarnings(input.judgements, input.files));
    }

    return { errors, warnings };
}

const BARE_PATH = /(?<![\w/.@-])([\w@-][\w.@-]*\.[A-Za-z0-9]+):(\d+)\b/g;

/**
 * Two things render cannot do for the reader: link a bare `name.ts:12` (it needs the repository path),
 * and show that every changed file was read (`# Checked and fine` names each one).
 */
function pathWarnings(judgements: Judgements, files: DiffFile[]): CheckProblem[] {
    const problems: CheckProblem[] = [];
    const byName = new Map<string, string[]>();

    for (const file of files) {
        const name = file.path.split("/").pop() ?? file.path;
        byName.set(name, [...(byName.get(name) ?? []), file.path]);
    }

    for (const item of judgements.items) {
        const texts = [...item.fields.values(), ...[...item.bullets.values()].flat()];

        for (const text of texts) {
            for (const match of text.matchAll(BARE_PATH)) {
                const full = byName.get(match[1]);

                if (full?.length === 1) {
                    problems.push({
                        id: item.id,
                        line: item.line,
                        message: `\`${match[0]}\` is not linked: write the repository path \`${full[0]}:${match[2]}\``,
                    });
                }
            }
        }
    }

    const checked = judgements.sections.get("Checked and fine");

    if (checked !== undefined) {
        const missing = files
            .filter((file) => file.status !== "deleted")
            .map((file) => file.path)
            .filter((path) => !checked.includes(path) && !checked.includes(path.split("/").pop() ?? path));

        if (missing.length > 0) {
            problems.push({
                id: "file",
                line: 0,
                message: `\`# Checked and fine\` does not name ${missing.length} changed file(s): ${missing.join(", ")} (one bullet per file: what you checked in it)`,
            });
        }
    }

    return problems;
}
