/**
 * Renderers for `tools gitlab pr review`: the markdown report (json2md blocks, never concatenated
 * strings), the compact `--llm` view with f/t/d/m refs, the `--expand` drill-down, and the
 * `gt:review-proposal` skeleton that `tools hub proposal push` accepts once an agent adds a verdict
 * and drafts.
 */

import { basename, join } from "node:path";
import { hostnameOf } from "@app/gitlab/lib/client";
import {
    type DiffFile,
    firstChangedLine,
    linkBase,
    type PrReviewFacts,
    type PrReviewGate,
} from "@app/gitlab/lib/pr-review";
import { type BlockInput, json2md } from "@genesiscz/utils/json2md";

const pad = (n: number): string => String(n).padStart(2, "0");

/** One line of text: whitespace collapsed, cut at `max` with an ellipsis. */
function flat(text: string, max = 120): string {
    const oneLine = text.replace(/\s+/g, " ").trim();

    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** `[File.ts:91](file:///abs/File.ts#L91)`, the link form a terminal renders as clickable. Line 1 when unknown. */
export function fileLink(absPath: string, line?: number | null): string {
    const at = line && line > 0 ? line : 1;
    const target = encodeURI(absPath).replace(/#/g, "%23");

    return `[${basename(absPath)}:${at}](file://${target}#L${at})`;
}

/** A clickable local link when a checkout is known, else `path:line` in code. */
function anchor(facts: PrReviewFacts, path: string | null, line: number | null): string {
    if (!path) {
        return "top-level";
    }

    const base = linkBase(facts);

    return base ? fileLink(join(base, path), line) : `\`${path}:${line ?? 1}\``;
}

function totals(facts: PrReviewFacts): { additions: number; deletions: number; unresolved: number } {
    return {
        additions: facts.files.reduce((sum, file) => sum + file.additions, 0),
        deletions: facts.files.reduce((sum, file) => sum + file.deletions, 0),
        unresolved: facts.discussions.filter((d) => !d.resolved).length,
    };
}

function worktreeLine(facts: PrReviewFacts): string {
    if (!facts.repoPath) {
        return "Checkout: none given (`--repo <checkout>`); file references are repository paths.";
    }

    if (!facts.worktree) {
        return `⚠️ Worktree: none has \`${facts.sourceBranch}\` checked out. The links point at \`${facts.repoPath}\`, which is NOT the MR code. Create one with \`git worktree add <dir> ${facts.sourceBranch}\`, then re-run.`;
    }

    if (facts.worktreeHead !== facts.headSha) {
        return `⚠️ Worktree: \`${facts.worktree}\` is at \`${(facts.worktreeHead ?? "?").slice(0, 10)}\`, the MR head is \`${facts.headSha.slice(0, 10)}\`. Run \`git -C ${facts.worktree} pull --ff-only\` before you read the files.`;
    }

    return `Worktree: \`${facts.worktree}\` (HEAD is the MR head)`;
}

/** The hunks of one file as numbered text: new-side numbers, removed lines unnumbered, `⋯` between hunks. */
export function numberedHunks(file: DiffFile): string {
    const width = String(Math.max(...file.hunks.map((h) => h.newStart + h.lines.length), 1)).length;
    const body: string[] = [];

    for (const [i, hunk] of file.hunks.entries()) {
        if (i > 0) {
            body.push(`${" ".repeat(width)}   ⋯ ${hunk.header}`.trimEnd());
        }

        for (const line of hunk.lines) {
            const number = line.newLine === null ? " ".repeat(width) : String(line.newLine).padStart(width);
            body.push(`${number} ${line.kind} ${line.text}`);
        }
    }

    return body.join("\n");
}

function fileBlocks(facts: PrReviewFacts, file: DiffFile, index: number): BlockInput {
    const heading = {
        h3: `${pad(index + 1)} \`${file.path}\` · ${file.status} · +${file.additions} −${file.deletions}`,
    };
    const renamed = file.status === "renamed" ? `Renamed from \`${file.oldPath}\`.` : [];

    if (file.status === "deleted") {
        return [heading, `Deleted: ${file.deletions} lines removed. Nothing to anchor on the new side.`];
    }

    if (file.binary) {
        return [heading, renamed, "Binary file."];
    }

    if (file.truncated) {
        return [heading, renamed, "GitLab collapsed this diff (too large). Read the file in the checkout."];
    }

    return [
        heading,
        renamed,
        anchor(facts, file.path, firstChangedLine(file)),
        file.hunks.length > 0 ? { code: { content: numberedHunks(file), language: "text" } } : "No content change.",
    ];
}

function threadRows(facts: PrReviewFacts): BlockInput {
    if (facts.discussions.length === 0) {
        return "None.";
    }

    return {
        table: {
            rows: facts.discussions.map((d) => ({
                author: `@${d.author}`,
                anchor: anchor(facts, d.path, d.line),
                resolved: d.resolved ? "yes" : "no",
                note: flat(d.body),
            })),
            columns: [{ key: "author" }, { key: "anchor" }, { key: "resolved" }, { key: "note", header: "first note" }],
        },
    };
}

function impactBlocks(facts: PrReviewFacts): BlockInput {
    if (facts.impact === null) {
        return "Not scanned (`--no-impact`, or the scan failed; see the warnings).";
    }

    const removed = facts.removedModules.length === 0 ? "none" : facts.removedModules.map((m) => `\`${m}\``).join(", ");
    const summary = `Scanned ${facts.impactScanned} open MRs. Deleted or renamed modules: ${removed}.`;

    if (facts.impact.length === 0) {
        return [summary, "No open MR imports a removed module or changes the same files."];
    }

    return [
        summary,
        {
            table: {
                rows: facts.impact.map((entry) => ({
                    mr: `[!${entry.iid}](${entry.webUrl}) ${flat(entry.title, 60)}`,
                    author: `@${entry.author}`,
                    imports:
                        entry.imports
                            .map((hit) => `\`${hit.path}\`:${hit.newLine ?? "?"} → \`${hit.specifier}\``)
                            .join("<br>") || "-",
                    shared: entry.sharedFiles.map((path) => `\`${path}\``).join("<br>") || "-",
                })),
                columns: [
                    { key: "mr", header: "MR" },
                    { key: "author" },
                    { key: "imports", header: "adds an import of a removed module" },
                    { key: "shared", header: "also changes" },
                ],
            },
        },
    ];
}

function gateBlocks(facts: PrReviewFacts): BlockInput {
    if (facts.gates.length === 0) {
        return [];
    }

    const lines = [`cd ${linkBase(facts) ?? "<checkout>"}`];

    for (const gate of facts.gates) {
        lines.push(`# ${gate.label}`, gate.command);
    }

    return [
        { h2: "Gates" },
        "Run them in the MR checkout. All must exit 0 before a verdict says the MR is clean.",
        { code: { content: lines.join("\n"), language: "bash" } },
    ];
}

/** The review report as json2md blocks. */
export function prReviewBlocks(facts: PrReviewFacts): BlockInput {
    const { additions, deletions, unresolved } = totals(facts);

    return [
        { h1: `Review: !${facts.iid} ${facts.title}` },
        {
            ul: [
                `Author: @${facts.author} · \`${facts.sourceBranch}\` → \`${facts.targetBranch}\` · head \`${facts.headSha.slice(0, 10)}\` · diff from ${facts.diffSource}`,
                `MR: ${facts.webUrl}`,
                worktreeLine(facts),
                `Files: ${facts.files.length} changed (+${additions} −${deletions}) · Existing threads: ${facts.discussions.length} (${unresolved} unresolved) · Your pending drafts: ${facts.drafts.length}`,
            ],
        },
        facts.warnings.length > 0
            ? { callout: { kind: "warning", title: "Partial facts", body: { ul: facts.warnings } } }
            : [],
        { h2: "Checklist" },
        "Mark every file before you write the report. A file counts as read when you read its hunks, or when a script proved the change mechanical (name the script in the report).",
        {
            tasks: facts.files.map((file, i) => ({
                text: `${pad(i + 1)} · ${file.status} · +${file.additions} −${file.deletions}${file.status === "deleted" ? "" : ` · ${anchor(facts, file.path, firstChangedLine(file))}`} · \`${file.path}\``,
                checked: false,
            })),
        },
        { h2: "Existing threads" },
        threadRows(facts),
        { h2: "Your pending drafts" },
        facts.drafts.length === 0
            ? "None."
            : {
                  ul: facts.drafts.map(
                      (draft) => `${draft.id} · ${anchor(facts, draft.path, draft.line)} · ${flat(draft.note)}`
                  ),
              },
        { h2: "Open MRs this one affects" },
        impactBlocks(facts),
        gateBlocks(facts),
        { h2: "Files" },
        "Numbers are new-side lines (draft with side `additions`). Removed lines carry no number; their old-side line is in the JSON (`oldLine`, side `deletions`).",
        facts.files.map((file, i) => fileBlocks(facts, file, i)),
    ];
}

export function renderPrReviewMarkdown(facts: PrReviewFacts): string {
    return json2md(prReviewBlocks(facts));
}

// ─── --llm ─────────────────────────────────────────────────────────────────────

function lineRef(path: string | null, line: number | null): string {
    if (!path) {
        return "top-level";
    }

    return line ? `${path}:${line}` : path;
}

function gateLine(gate: PrReviewGate, index: number): string {
    return `  g${index + 1}  ${gate.label}: ${gate.command}`;
}

/** Compact first-level view with refs (f1 files, t1 threads, d1 drafts, m1 affected MRs) for `--expand`. */
export function formatPrReviewLLM(facts: PrReviewFacts, command: string): string {
    const { additions, deletions, unresolved } = totals(facts);
    const lines = [
        `=== GitLab MR review: ${facts.project}!${facts.iid} ===`,
        `!${facts.iid} ${facts.title} | @${facts.author} | ${facts.sourceBranch} → ${facts.targetBranch} | head ${facts.headSha.slice(0, 10)} | diff from ${facts.diffSource}`,
        `Files: ${facts.files.length} (+${additions} −${deletions}) | Threads: ${facts.discussions.length} (${unresolved} unresolved) | My drafts: ${facts.drafts.length} | Affected MRs: ${facts.impact === null ? "not scanned" : `${facts.impact.length} of ${facts.impactScanned} scanned`}`,
    ];

    for (const warning of facts.warnings) {
        lines.push(`Warning: ${warning}`);
    }

    lines.push("", "Files:");
    facts.files.forEach((file, i) => {
        lines.push(`  f${i + 1}  ${file.status}  +${file.additions} −${file.deletions}  ${file.path}`);
    });

    if (facts.discussions.length > 0) {
        lines.push("", "Threads:");
        facts.discussions.forEach((d, i) => {
            lines.push(
                `  t${i + 1}  ${d.resolved ? "RESOLVED" : "UNRESOLVED"}  ${lineRef(d.path, d.line)}  @${d.author}  ${d.noteCount}n  ${flat(d.body, 60)}`
            );
        });
    }

    if (facts.drafts.length > 0) {
        lines.push("", "My drafts:");
        facts.drafts.forEach((draft, i) => {
            lines.push(`  d${i + 1}  ${lineRef(draft.path, draft.line)}  ${flat(draft.note, 60)}`);
        });
    }

    if (facts.impact && facts.impact.length > 0) {
        lines.push("", "Affected MRs:");
        facts.impact.forEach((entry, i) => {
            lines.push(
                `  m${i + 1}  !${entry.iid}  ${entry.imports.length} imports, ${entry.sharedFiles.length} shared  @${entry.author}  ${flat(entry.title, 50)}`
            );
        });
    }

    if (facts.gates.length > 0) {
        lines.push("", "Gates:", ...facts.gates.map(gateLine));
    }

    lines.push("", `Expand: ${command} --expand f1,t1`, `Markdown: ${command} --md`);

    return `${lines.join("\n")}\n`;
}

/** The hunk lines around `line` (new side), for a thread or draft. */
function excerptAround(facts: PrReviewFacts, path: string | null, line: number | null, context = 3): string | null {
    const file = facts.files.find((candidate) => candidate.path === path);

    if (!file || !line) {
        return null;
    }

    const near = file.hunks
        .flatMap((hunk) => hunk.lines)
        .filter(
            (l) => (l.newLine ?? l.oldLine ?? 0) >= line - context && (l.newLine ?? l.oldLine ?? 0) <= line + context
        );

    return near.length === 0
        ? null
        : near
              .map((l) => `${String(l.newLine ?? "").padStart(5)} ${l.newLine === line ? "▶" : l.kind} ${l.text}`)
              .join("\n");
}

/** One ref in full. Unknown refs come back as an error line, never a throw, so a batch still prints the rest. */
function expandOne(facts: PrReviewFacts, ref: string): string {
    const match = /^([ftdm])(\d+)$/.exec(ref.trim());
    const index = match ? Number(match[2]) - 1 : -1;

    switch (match?.[1]) {
        case "f": {
            const file = facts.files[index];

            if (!file) {
                break;
            }

            const renamed = file.status === "renamed" ? ` (from ${file.oldPath})` : "";
            const body = file.binary
                ? "Binary file."
                : file.truncated
                  ? "Collapsed by GitLab (too large)."
                  : numberedHunks(file);

            return `=== ${ref} ${file.path}${renamed} · ${file.status} · +${file.additions} −${file.deletions} ===\n${body}\n`;
        }
        case "t": {
            const d = facts.discussions[index];

            if (!d) {
                break;
            }

            const excerpt = excerptAround(facts, d.path, d.line);

            return [
                `=== ${ref} ${lineRef(d.path, d.line)} · ${d.resolved ? "RESOLVED" : "UNRESOLVED"} · @${d.author} · ${d.noteCount} notes ===`,
                `Discussion id: ${d.id}`,
                d.body,
                excerpt ? `\nDiff context:\n${excerpt}` : "",
                "",
            ].join("\n");
        }
        case "d": {
            const draft = facts.drafts[index];

            if (!draft) {
                break;
            }

            return `=== ${ref} draft ${draft.id} · ${lineRef(draft.path, draft.line)}${draft.discussionId ? ` · reply in ${draft.discussionId}` : ""} ===\n${draft.note}\n`;
        }
        case "m": {
            const entry = facts.impact?.[index];

            if (!entry) {
                break;
            }

            const imports = entry.imports.map(
                (hit) => `  ${hit.path}:${hit.newLine ?? "?"} → ${hit.specifier}: ${hit.text}`
            );
            const shared = entry.sharedFiles.map((path) => `  ${path}`);

            return [
                `=== ${ref} !${entry.iid} ${entry.title} · @${entry.author} ===`,
                entry.webUrl,
                imports.length > 0
                    ? `Imports of removed modules:\n${imports.join("\n")}`
                    : "Imports of removed modules: none",
                shared.length > 0 ? `Also changes:\n${shared.join("\n")}` : "Also changes: none",
                "",
            ].join("\n");
        }
    }

    return `=== ${ref}: no such ref (use f1…f${facts.files.length}, t1…t${facts.discussions.length}, d1…d${facts.drafts.length}, m1…m${facts.impact?.length ?? 0}) ===\n`;
}

export function expandRefs(facts: PrReviewFacts, refs: string[]): string {
    return refs.map((ref) => expandOne(facts, ref)).join("\n");
}

// ─── --proposal-skeleton ───────────────────────────────────────────────────────

/**
 * A `gt:review-proposal` document pre-filled from the facts. The agent replaces the verdict, sets
 * author.agent and adds drafts; `tools hub proposal push` validates it. Unresolved threads are
 * listed so the agent can judge each one.
 */
export function proposalSkeleton(facts: PrReviewFacts, agent = "agent"): Record<string, unknown> {
    return {
        provider: "gitlab",
        host: hostnameOf(facts.host),
        project: facts.project,
        number: facts.iid,
        url: facts.webUrl,
        title: facts.title,
        sourceBranch: facts.sourceBranch,
        targetBranch: facts.targetBranch,
        baseSha: facts.baseSha,
        headSha: facts.headSha,
        ...(facts.worktree || facts.repoPath ? { repoPath: facts.worktree ?? facts.repoPath } : {}),
        author: { agent },
        verdict: {
            decision: "comment",
            summary: "Replace with the verdict: what the MR does and whether it is ready.",
        },
        drafts: [],
        // Every thread with its real state, as the review-proposal skill asks: the window counts
        // resolved and open threads apart, and a skeleton of open ones only showed too few.
        threads: facts.discussions.map((d) => ({
            threadId: d.id,
            ...(d.path ? { path: d.path } : {}),
            ...(d.line && d.line > 0 ? { line: d.line } : {}),
            author: d.author,
            ...(d.body.trim() ? { body: d.body } : {}),
            noteCount: d.noteCount,
            resolved: d.resolved,
        })),
    };
}
