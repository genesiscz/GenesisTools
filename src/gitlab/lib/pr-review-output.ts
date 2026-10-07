/**
 * Renderers for `tools gitlab pr <iid> review --give`: the markdown report (json2md blocks, never concatenated
 * strings), the compact `--llm` view with f/t/d/m refs, the `--expand` drill-down, and the review
 * proposal skeleton (`--proposal-skeleton`).
 * The `gt:review-proposal` skill says how to fill the proposal and push it with `tools hub proposal push`.
 */

import { join } from "node:path";
import { hostnameOf } from "@app/gitlab/lib/client";
import { fileLink } from "@app/gitlab/lib/file-link";
import { fenceLanguage } from "@app/gitlab/lib/markdown";
import {
    type DiffFile,
    firstChangedLine,
    linkBase,
    type PrReviewFacts,
    type PrReviewGate,
} from "@app/gitlab/lib/pr-review";
import type { DraftSummary } from "@app/gitlab/lib/review-drafts";
import {
    type Discussion,
    type RenderMarkdownOpts,
    threadSections,
    threadSectionsOf,
} from "@app/gitlab/lib/review-render";
import { detectGenesisTools } from "@genesiscz/utils/cli/genesis-tools";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type BlockInput, json2md } from "@genesiscz/utils/json2md";
import { shellWord } from "@genesiscz/utils/shell/quote";

const pad = (n: number): string => String(n).padStart(2, "0");

/** One line of text: whitespace collapsed, cut at `max` with an ellipsis. */
function flat(text: string, max = 120): string {
    const oneLine = text.replace(/\s+/g, " ").trim();

    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** A clickable local link when a checkout is known, else `path:line` in code. */
function anchor(facts: PrReviewFacts, path: string | null, line: number | null): string {
    if (!path) {
        return "top-level";
    }

    const base = linkBase(facts);

    return base ? fileLink(join(base, path), line, { root: base }) : `\`${path}:${line ?? 1}\``;
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
        const advice = facts.worktreeHint
            ? facts.worktreeHint.replaceAll("{branch}", facts.sourceBranch).replaceAll("{iid}", String(facts.iid))
            : `Create one with \`git worktree add <dir> ${facts.sourceBranch}\`, then re-run.`;

        return `⚠️ Worktree: none has \`${facts.sourceBranch}\` checked out. The links point at \`${facts.repoPath}\`, which is NOT the MR code. ${advice}`;
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
        h3: `${file.ref ?? pad(index + 1)} \`${file.path}\` · ${file.status} · +${file.additions} −${file.deletions}`,
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
        file.hunks.length > 0
            ? { code: { content: numberedHunks(file), language: fenceLanguage(file.path) } }
            : "No content change.",
    ];
}

function threadRows(facts: PrReviewFacts): BlockInput {
    if (facts.discussions.length === 0) {
        return "None.";
    }

    return {
        table: {
            rows: facts.discussions.map((d) => ({
                id: d.ref ?? "",
                author: `@${d.author}`,
                anchor: anchor(facts, d.path, d.line),
                resolved: d.resolved ? "yes" : "no",
                note: flat(d.body),
            })),
            columns: [
                ...(facts.discussions.some((d) => d.ref) ? [{ key: "id" }] : []),
                { key: "author" },
                { key: "anchor" },
                { key: "resolved" },
                { key: "note", header: "first note" },
            ],
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

/**
 * A `tools task` session name per gate label, unique within the block. Checked against every name
 * already given out, suffixed ones included: labels `unit`, `unit`, `unit-2` must not yield two
 * `unit-2` sessions, which `task run` would share.
 */
export function sessionNames(gates: PrReviewGate[]): string[] {
    const used = new Set<string>();

    return gates.map((gate) => {
        const base =
            gate.label
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || "gate";
        let name = base;

        for (let n = 2; used.has(name); n++) {
            name = `${base}-${n}`;
        }

        used.add(name);

        return name;
    });
}

/** The first line of a gate script: a checkout that cannot be entered stops it before any gate runs elsewhere. */
function enterCheckout(root: string): string {
    return `cd -- ${shellWord(root)} || exit 1`;
}

function doubleQuoted(command: string): string {
    return `"${command.replace(/(["\\$`])/g, "\\$1")}"`;
}

function listedGates(root: string, gates: PrReviewGate[]): string {
    return [enterCheckout(root), ...gates.flatMap((gate) => [`# ${gate.label}`, gate.command])].join("\n");
}

/**
 * Each gate as a background session of the GenesisTools `tools task` runner, a wait, then every
 * exit code. When no install is found, the same gates are listed as plain commands.
 * Named literally: a fork's own `task` command is a different tool.
 */
function parallelRunner(root: string, gates: PrReviewGate[]): string {
    const bin = detectGenesisTools()?.binPath ?? null;
    if (bin === null) {
        return listedGates(root, gates);
    }

    const sessions = sessionNames(gates);
    const lines = [enterCheckout(root), 'P=$(basename "$PWD"); pids=()'];
    const cmd = doubleQuoted(bin);

    gates.forEach((gate, i) => {
        lines.push(
            `${cmd} task run --session "$P-${sessions[i]}" --no-tty -- bash -c ${doubleQuoted(gate.command)} >/dev/null 2>&1 & pids+=($!)`
        );
    });

    lines.push(
        'wait "${pids[@]}"',
        `for s in ${sessions.map((s) => `"$P-${s}"`).join(" ")}; do printf '%-24s: ' "$s"; ${cmd} task get --session "$s" 2>&1 | grep -oE 'exited \\(code [0-9]+' | head -1; done`
    );

    return lines.join("\n");
}

function gateBlocks(facts: PrReviewFacts): BlockInput {
    if (facts.gates.length === 0) {
        return [];
    }

    const root = linkBase(facts) ?? "<checkout>";
    const runnable = facts.gates.filter((gate) => gate.note === null);
    const noted = facts.gates.filter((gate) => gate.note !== null).map((gate) => `${gate.label}: ${gate.note}`);
    const listed = listedGates(root, runnable);
    const script = facts.gateRunner === "parallel" ? parallelRunner(root, runnable) : listed;

    return [
        { h2: "Gates" },
        "Run them in the MR checkout. All must exit 0 before a verdict says the MR is clean.",
        runnable.length > 0 ? { code: { content: script, language: "bash" } } : [],
        noted,
    ];
}

export type DraftPlacement =
    | "added line"
    | "context line"
    | "removed line"
    | "outside the diff"
    | "file not in the diff"
    | "top-level";

export interface DraftExcerpt {
    placement: DraftPlacement;
    lines: string[];
}

/** Where a draft sits in the MR diff, with the hunk lines around it. `▶` marks the anchored line. */
export function draftExcerpt(files: DiffFile[], draft: DraftSummary, radius = 6): DraftExcerpt {
    if (!draft.path || draft.line === null) {
        return { placement: "top-level", lines: [] };
    }

    const file = files.find((f) => f.path === draft.path || f.oldPath === draft.path);

    if (!file) {
        return { placement: "file not in the diff", lines: [] };
    }

    const onOldSide = draft.side === "old";

    for (const hunk of file.hunks) {
        const index = hunk.lines.findIndex((l) =>
            onOldSide ? l.kind === "-" && l.oldLine === draft.line : l.kind !== "-" && l.newLine === draft.line
        );
        const target = hunk.lines[index];

        if (!target) {
            continue;
        }

        const slice = hunk.lines.slice(Math.max(0, index - radius), index + radius + 1);
        const width = String(Math.max(...slice.map((l) => Math.max(l.newLine ?? 0, l.oldLine ?? 0)), 1)).length;
        const num = (n: number | null): string => (n === null ? " ".repeat(width) : String(n).padStart(width));
        const placement: DraftPlacement =
            target.kind === "+" ? "added line" : target.kind === "-" ? "removed line" : "context line";

        return {
            placement,
            lines: slice.map(
                (l) => `${l === target ? "▶" : " "} ${num(l.oldLine)} ${num(l.newLine)} ${l.kind} ${l.text}`
            ),
        };
    }

    return { placement: "outside the diff", lines: [] };
}

function draftTarget(draft: DraftSummary): string {
    if (draft.discussionId) {
        return `reply in existing thread \`${draft.discussionId}\``;
    }

    return draft.path ? "new thread on a line" : "new top-level note";
}

/** Every pending draft in full: body, reply target, placement in the diff, and the code around it. */
export function draftBlocks(facts: PrReviewFacts): BlockInput {
    if (facts.drafts.length === 0) {
        return "None.";
    }

    const iid = String(facts.iid);
    const sorted = [...facts.drafts].sort(
        (a, b) => (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.id - b.id
    );

    return [
        `${facts.drafts.length} unpublished draft(s). They are visible only to their author.`,
        {
            blockquote: `🛑 A draft that opens a new thread has no discussion yet. Nobody can reply to it, you included, until the review is published with \`${toolCommand("gitlab pr", iid, "comments", "publish", "--apply")}\`. After publishing, \`${toolCommand("gitlab pr", iid, "comments", "--mine", "--json")}\` gives the new discussion ids; match them by path and line.`,
        },
        sorted.map((draft, i): BlockInput => {
            const excerpt = draftExcerpt(facts.files, draft);
            const where = draft.path
                ? anchor(facts, draft.path, draft.line)
                : draft.discussionId
                  ? "reply"
                  : "top-level";

            return [
                { h3: `${draft.ref ?? `D${pad(i + 1)}`} · draft ${draft.id} · ${where}` },
                {
                    ul: [
                        `Target: ${draftTarget(draft)}`,
                        `Placement: ${excerpt.placement}${draft.side === "old" ? " (old side)" : ""}`,
                    ],
                },
                { code: { content: draft.note, language: "markdown" } },
                excerpt.lines.length > 0
                    ? [
                          "Code at the anchor (old · new · kind):",
                          { code: { content: excerpt.lines.join("\n"), language: fenceLanguage(draft.path ?? "") } },
                      ]
                    : excerpt.placement === "outside the diff"
                      ? `⚠️ Line ${draft.line} is outside every hunk shown with the current context. Read it in the checkout.`
                      : [],
            ];
        }),
    ];
}

/** Extra sections a report can carry beside the facts. */
export interface ReportExtras {
    /** `--threads`: every unresolved diff thread in full, as `fetch-review` renders it. */
    threads?: { discussions: Discussion[]; opts: RenderMarkdownOpts };
    /** My published threads (`Y`) in full, for the Your comments section. */
    mine?: { discussions: Discussion[]; opts: RenderMarkdownOpts };
}

/** The count line of the Your comments section. */
export function yourCommentsLine(facts: PrReviewFacts): string {
    const threads = facts.discussions.filter((d) => d.ref?.startsWith("Y")).length;

    return `Your comments: ${facts.drafts.length} pending draft${facts.drafts.length === 1 ? "" : "s"}, ${threads} published thread${threads === 1 ? "" : "s"}`;
}

/** My pending drafts (`D`), then my published threads (`Y`) in full. */
function yourCommentsBlocks(facts: PrReviewFacts, extras: ReportExtras): BlockInput {
    const mine = extras.mine && extras.mine.discussions.length > 0 ? extras.mine : null;

    return [
        yourCommentsLine(facts),
        { h3: "Pending drafts" },
        draftBlocks(facts),
        mine ? [{ h3: "Published threads" }, threadSectionsOf(mine.discussions, mine.opts)] : [],
    ];
}

function threadBlocksOf(extras: ReportExtras): BlockInput {
    if (!extras.threads) {
        return [];
    }

    const sections = threadSections(extras.threads.discussions, extras.threads.opts);

    return [
        { h2: "Unresolved threads in full" },
        Array.isArray(sections) && sections.length === 0 ? "None." : sections,
    ];
}

/** The drafts-only report: the header plus every pending draft in full, for a pass over one's own review. */
/** `--mine-only`: my comments on the MR (pending drafts and published threads), no impact scan. */
export function renderDraftsOnlyMarkdown(facts: PrReviewFacts, extras: ReportExtras = {}): string {
    return json2md([
        { h1: `Your comments: !${facts.iid} ${facts.title}` },
        {
            ul: [
                `Author: @${facts.author} · \`${facts.sourceBranch}\` → \`${facts.targetBranch}\` · head \`${facts.headSha.slice(0, 10)}\``,
                `MR: ${facts.webUrl}`,
                worktreeLine(facts),
            ],
        },
        yourCommentsBlocks(facts, extras),
        threadBlocksOf(extras),
    ]);
}

/** The review report as json2md blocks. */
export function prReviewBlocks(facts: PrReviewFacts, extras: ReportExtras = {}): BlockInput {
    const { additions, deletions, unresolved } = totals(facts);

    return [
        { h1: `Review: !${facts.iid} ${facts.title}` },
        {
            ul: [
                `Author: @${facts.author} · \`${facts.sourceBranch}\` → \`${facts.targetBranch}\` · head \`${facts.headSha.slice(0, 10)}\` · diff from ${facts.diffSource}`,
                `MR: ${facts.webUrl}`,
                worktreeLine(facts),
                `Files: ${facts.files.length} changed (+${additions} −${deletions}) · Existing threads: ${facts.discussions.length} (${unresolved} unresolved) · ${yourCommentsLine(facts)}`,
            ],
        },
        facts.warnings.length > 0
            ? { callout: { kind: "warning", title: "Partial facts", body: { ul: facts.warnings } } }
            : [],
        { h2: "Checklist" },
        "Mark every file before you write the report. A file counts as read when you read its hunks, or when a script proved the change mechanical (name the script in the report).",
        {
            tasks: facts.files.map((file, i) => ({
                text: `${file.ref ?? pad(i + 1)} · ${file.status} · +${file.additions} −${file.deletions}${file.status === "deleted" ? "" : ` · ${anchor(facts, file.path, firstChangedLine(file))}`} · \`${file.path}\``,
                checked: false,
            })),
        },
        threadBlocksOf(extras),
        { h2: "Existing threads" },
        threadRows(facts),
        { h2: "Your comments" },
        yourCommentsBlocks(facts, extras),
        { h2: "Open MRs this one affects" },
        impactBlocks(facts),
        gateBlocks(facts),
        { h2: "Files" },
        "Numbers are new-side lines (draft with side `additions`). Removed lines carry no number; their old-side line is in the JSON (`oldLine`, side `deletions`).",
        facts.files.map((file, i) => fileBlocks(facts, file, i)),
    ];
}

export function renderPrReviewMarkdown(facts: PrReviewFacts, extras: ReportExtras = {}): string {
    return json2md(prReviewBlocks(facts, extras));
}

// ─── --llm ─────────────────────────────────────────────────────────────────────

function lineRef(path: string | null, line: number | null): string {
    if (!path) {
        return "top-level";
    }

    return line ? `${path}:${line}` : path;
}

function gateLine(gate: PrReviewGate, index: number): string {
    return `  g${index + 1}  ${gate.label}: ${gate.note ?? gate.command}`;
}

/** Compact first-level view with ids (F01 files, T01 threads, Y01 my threads, D01 drafts, M01 affected MRs) for `--expand`. */
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
        lines.push(`  ${file.ref ?? `f${i + 1}`}  ${file.status}  +${file.additions} −${file.deletions}  ${file.path}`);
    });

    if (facts.discussions.length > 0) {
        lines.push("", "Threads:");
        facts.discussions.forEach((d, i) => {
            lines.push(
                `  ${d.ref ?? `t${i + 1}`}  ${d.resolved ? "RESOLVED" : "UNRESOLVED"}  ${lineRef(d.path, d.line)}  @${d.author}  ${d.noteCount}n  ${flat(d.body, 60)}`
            );
        });
    }

    if (facts.drafts.length > 0) {
        lines.push("", "My drafts:");
        facts.drafts.forEach((draft, i) => {
            lines.push(`  ${draft.ref ?? `d${i + 1}`}  ${lineRef(draft.path, draft.line)}  ${flat(draft.note, 60)}`);
        });
    }

    if (facts.impact && facts.impact.length > 0) {
        lines.push("", "Affected MRs:");
        facts.impact.forEach((entry, i) => {
            lines.push(
                `  ${entry.ref ?? `m${i + 1}`}  !${entry.iid}  ${entry.imports.length} imports, ${entry.sharedFiles.length} shared  @${entry.author}  ${flat(entry.title, 50)}`
            );
        });
    }

    if (facts.gates.length > 0) {
        lines.push("", "Gates:", ...facts.gates.map(gateLine));
    }

    const sample = [facts.files[0]?.ref ?? "f1", facts.discussions[0]?.ref ?? "t1"].join(",");
    lines.push("", `Expand: ${command} --expand ${sample}`, `Markdown: ${command} --md`);

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
/** The kind and the position of an id: a stored ref (`T03`) first, the older positional form (`t3`) after. */
function locate(facts: PrReviewFacts, ref: string): { kind: "f" | "t" | "d" | "m"; index: number } | null {
    const wanted = ref.trim().toUpperCase();
    const lists = [
        ["f", facts.files],
        ["t", facts.discussions],
        ["d", facts.drafts],
        ["m", facts.impact ?? []],
    ] as const;

    for (const [kind, list] of lists) {
        const index = list.findIndex((item) => item.ref?.toUpperCase() === wanted);

        if (index !== -1) {
            return { kind, index };
        }
    }

    const match = /^([ftdm])(\d+)$/.exec(ref.trim());

    return match ? { kind: match[1] as "f" | "t" | "d" | "m", index: Number(match[2]) - 1 } : null;
}

function expandOne(facts: PrReviewFacts, ref: string): string {
    const located = locate(facts, ref);
    const index = located?.index ?? -1;

    switch (located?.kind) {
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

    return `=== ${ref}: no such id (the --llm view lists every id) ===\n`;
}

export function expandRefs(facts: PrReviewFacts, refs: string[]): string {
    return refs.map((ref) => expandOne(facts, ref)).join("\n");
}

// ─── --proposal-skeleton ───────────────────────────────────────────────────────

/**
 * A review proposal pre-filled from the facts. The agent replaces the verdict, sets author.agent and
 * adds drafts. Unresolved threads are listed so the agent can judge each one.
 * The `gt:review-proposal` skill says how to fill the proposal and push it with `tools hub proposal push`.
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

export { fenceLanguage };
