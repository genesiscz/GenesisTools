import { isWrapperUserText } from "@genesiscz/utils/agent-sessions/user-text";
import type { TranscriptProvider, TranscriptTool, TranscriptTurn } from "@genesiscz/utils/ai/transcripts";
import { promptLabel, sectionsOf } from "./timeline";
import { isFailedTool, keyArgument, summarizeTools, toolDisplayName, toolKind } from "./tool-kind";

// The handoff composer: a markdown brief of a range of prompts, built from the transcript's
// structure alone (no model call), so the same range always gives the same text. The hub's
// composer sheet, `tools hub handoff` and a posted handoff (`--post`) all print this.

export const DEFAULT_HANDOFF_PROMPTS = 5;
/** The "What happened" list keeps the latest this many prompts of a long range. */
const MAX_HAPPENED = 40;
const MAX_FILES = 25;
const MAX_OPEN_ITEMS = 12;

export type HandoffRange = { last: number } | { from: number; to: number };

export interface HandoffMeta {
    sessionId: string;
    provider: TranscriptProvider;
    title?: string | null;
    cwd?: string | null;
    branch?: string | null;
    /** `claude --resume <id>`, when the caller knows how this session resumes. */
    resumeCommand?: string | null;
}

export interface HandoffFile {
    path: string;
    edits: number;
    writes: number;
    reads: number;
}

export interface HandoffCommit {
    sha: string;
    branch: string;
    subject: string;
}

export interface HandoffDraft {
    title: string;
    markdown: string;
    /** "#N" numbers of the first and last prompt in the range; 0 when the range has no prompt. */
    fromNumber: number;
    toNumber: number;
    promptCount: number;
    goal: string;
    openItems: string[];
    changedFiles: HandoffFile[];
    readFiles: string[];
    commits: HandoffCommit[];
}

export class HandoffRangeError extends Error {}

function clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Inline code that survives a backtick inside the value. */
function code(text: string): string {
    const fence = text.includes("`") ? "``" : "`";
    return `${fence}${text}${fence}`;
}

/** The turns the range covers: from its first prompt up to the next prompt after its last one. */
export function selectRange(
    turns: readonly TranscriptTurn[],
    range: HandoffRange
): { start: number; end: number; prompts: number[] } {
    const prompts = turns.flatMap((turn, index) => (turn.role === "user" ? [index] : []));

    if (prompts.length === 0) {
        return { start: 0, end: turns.length, prompts: [] };
    }

    let picked: number[];

    if ("last" in range) {
        if (!Number.isInteger(range.last) || range.last < 1) {
            throw new HandoffRangeError(`--last takes a positive whole number, got ${range.last}`);
        }

        picked = prompts.slice(-range.last);
    } else {
        if (range.from > range.to) {
            throw new HandoffRangeError(`--from ${range.from} comes after --to ${range.to}`);
        }

        picked = prompts.filter((index) => index + 1 >= range.from && index + 1 <= range.to);

        if (picked.length === 0) {
            throw new HandoffRangeError(
                `no prompt between #${range.from} and #${range.to}; prompts run from #${(prompts[0] ?? 0) + 1} to #${(prompts.at(-1) ?? 0) + 1}`
            );
        }
    }

    const first = picked[0] ?? 0;
    const lastPrompt = picked.at(-1) ?? first;
    const next = prompts.find((index) => index > lastPrompt);
    return { start: first, end: next ?? turns.length, prompts: picked };
}

function isAbsolutePath(value: string): boolean {
    return (value.startsWith("/") || value.startsWith("~")) && !value.includes("\n");
}

function patchPaths(patch: string): string[] {
    const prefixes = ["*** Update File: ", "*** Add File: ", "*** Delete File: "];
    return patch.split("\n").flatMap((line) => {
        const prefix = prefixes.find((candidate) => line.startsWith(candidate));
        return prefix ? [line.slice(prefix.length).trim()] : [];
    });
}

function filesOf(tools: readonly TranscriptTool[]): Map<string, HandoffFile> {
    const files = new Map<string, HandoffFile>();
    const touch = (path: string, field: "edits" | "writes" | "reads") => {
        const clean = path.trim();

        if (!isAbsolutePath(clean)) {
            return;
        }

        const file = files.get(clean) ?? { path: clean, edits: 0, writes: 0, reads: 0 };
        file[field] += 1;
        files.set(clean, file);
    };

    for (const tool of tools) {
        const kind = toolKind(tool.name);

        if (kind === "edit") {
            if (tool.name === "apply_patch" || tool.inputPreview.includes("*** ")) {
                for (const path of patchPaths(tool.inputPreview)) {
                    touch(path, "edits");
                }
            } else if (tool.name === "Write" || tool.name === "write_file" || tool.name === "create_file") {
                touch(tool.inputPreview, "writes");
            } else {
                touch(tool.inputPreview, "edits");
            }
        } else if (kind === "read") {
            touch(tool.inputPreview, "reads");
        }
    }

    return files;
}

const COMMIT_LINE = /^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;

function commitsOf(tools: readonly TranscriptTool[]): HandoffCommit[] {
    const commits: HandoffCommit[] = [];
    const seen = new Set<string>();

    for (const tool of tools) {
        if (toolKind(tool.name) !== "command" || !tool.inputPreview.includes("git") || !tool.result) {
            continue;
        }

        for (const match of tool.result.matchAll(COMMIT_LINE)) {
            const [, branch = "", sha = "", subject = ""] = match;

            if (!seen.has(sha)) {
                seen.add(sha);
                commits.push({ sha, branch, subject: subject.trim() });
            }
        }
    }

    return commits;
}

/** The first one or two sentences of a reply, on one line. */
function gist(text: string, max = 280): string {
    const flat = text.replace(/\s+/g, " ").trim();
    const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g);
    const lead = sentences ? sentences.slice(0, 2).join("").trim() : flat;
    return clip(lead || flat, max);
}

const TODO_LINE =
    /^\s*(?:[-*]\s*)?(?:\[ \]|TODO\b|⏳|❓|Next:|Next step|Remaining|Pending|Open:|Still to do|Not done|Blocked)/i;

/** Items a next agent has to pick up, most urgent first. */
function openItemsOf(turns: readonly TranscriptTurn[], isRangeEnd: boolean): string[] {
    const items: string[] = [];
    const last = turns.at(-1);

    if (last?.role === "user") {
        items.push(`Answer the last prompt, which has no reply yet: "${clip(last.text, 200)}"`);
    }

    const tools = turns.flatMap((turn) => turn.tools);

    if (isRangeEnd && last && last.role !== "user") {
        for (const tool of last.tools.filter((candidate) => candidate.result === null)) {
            items.push(`${toolDisplayName(tool.name)} was still running: ${code(keyArgument(tool))}`);
        }
    }

    // A failure a later call of the same tool and argument fixed is history, not an open item.
    const settled = new Set<string>();

    for (const tool of [...tools].reverse()) {
        const key = `${tool.name}\u0000${keyArgument(tool)}`;

        if (!isFailedTool(tool)) {
            settled.add(key);
            continue;
        }

        if (settled.has(key)) {
            continue;
        }

        settled.add(key);
        const firstLine = tool.result
            ?.split("\n")
            .find((line) => line.trim())
            ?.trim();
        const exit = tool.exitCode !== undefined && tool.exitCode !== 0 ? ` (exit ${tool.exitCode})` : "";
        items.push(
            `${toolDisplayName(tool.name)} failed${exit}: ${code(keyArgument(tool))}${firstLine ? `: ${clip(firstLine, 160)}` : ""}`
        );
    }

    const reply = turns.findLast((turn) => turn.role !== "user" && turn.text.trim());

    for (const line of reply?.text.split("\n") ?? []) {
        if (TODO_LINE.test(line)) {
            items.push(`From the last reply: ${clip(line.replace(/^\s*[-*]\s*/, ""), 200)}`);
        }
    }

    return items.slice(0, MAX_OPEN_ITEMS);
}

function fileLine(file: HandoffFile): string {
    const changes = file.edits + file.writes;
    const what = file.writes > 0 && file.edits === 0 ? "written" : `${changes} edit${changes === 1 ? "" : "s"}`;
    return `- ${code(file.path)} (${what})`;
}

const CONTINUATION = "This session is being continued from a previous conversation";

/** A prompt that states work: not a slash command, a compaction's summary, or a harness delivery. */
function isWorkPrompt(turn: TranscriptTurn): boolean {
    const text = turn.text.trim();
    return (
        turn.role === "user" &&
        text.length > 0 &&
        !text.startsWith("/") &&
        !text.startsWith(CONTINUATION) &&
        !isWrapperUserText(text)
    );
}

/**
 * The goal: the range's first prompt that states work, else the last such prompt before the range
 * (a range that opens with `/compact` still carries the task it continues).
 */
function goalPrompt(turns: readonly TranscriptTurn[], start: number, end: number): TranscriptTurn | undefined {
    return (
        turns.slice(start, end).find(isWorkPrompt) ??
        turns.slice(0, start).findLast(isWorkPrompt) ??
        turns.slice(start, end).find((turn) => turn.role === "user")
    );
}

/** The markdown brief of `range`. Throws `HandoffRangeError` for a range with no prompt in it. */
export function composeHandoff(options: {
    turns: readonly TranscriptTurn[];
    meta: HandoffMeta;
    range: HandoffRange;
}): HandoffDraft {
    const { turns, meta } = options;
    const { start, end, prompts } = selectRange(turns, options.range);
    const slice = turns.slice(start, end);
    const tools = slice.flatMap((turn) => turn.tools);
    const goalTurn = goalPrompt(turns, start, end);
    const fromNumber = prompts.length > 0 ? (prompts[0] ?? 0) + 1 : 0;
    const toNumber = prompts.length > 0 ? (prompts.at(-1) ?? 0) + 1 : 0;
    // Without a title, the session is named by its first working prompt, not by the range's.
    const namedBy = turns.find(isWorkPrompt) ?? goalTurn;
    const name = meta.title?.trim() || (namedBy ? promptLabel(namedBy.text, 80) : meta.sessionId.slice(0, 8));
    const title = clip(`Continue: ${name}`, 120);
    const goal = goalTurn ? goalTurn.text.trim() : "";
    const files = [...filesOf(tools).values()];
    const changedFiles = files.filter((file) => file.edits + file.writes > 0);
    const readFiles = files.filter((file) => file.edits + file.writes === 0).map((file) => file.path);
    const commits = commitsOf(tools);
    const openItems = openItemsOf(slice, end === turns.length);

    const lines: string[] = [`# ${title}`, ""];
    const place = [
        `Session ${code(meta.sessionId)} (${meta.provider})`,
        meta.cwd ? `folder ${code(meta.cwd)}` : null,
        meta.branch ? `branch ${code(meta.branch)}` : null,
    ].filter((part): part is string => part !== null);
    lines.push(`- ${place.join(" · ")}`);

    if (prompts.length > 0) {
        const firstAt = slice[0]?.at?.slice(0, 16).replace("T", " ");
        const lastAt = slice
            .findLast((turn) => turn.at)
            ?.at?.slice(0, 16)
            .replace("T", " ");
        const when = firstAt && lastAt ? `, ${firstAt} to ${lastAt} UTC` : "";
        lines.push(
            `- Range: prompts #${fromNumber} to #${toNumber} (${prompts.length} prompt${prompts.length === 1 ? "" : "s"}${when})`
        );
    }

    if (meta.resumeCommand) {
        lines.push(
            `- Resume: ${code(meta.cwd ? `cd '${meta.cwd.replaceAll("'", "'\\''")}' && ${meta.resumeCommand}` : meta.resumeCommand)}`
        );
    }

    lines.push("", "## Goal", "");
    lines.push(
        goal
            ? goal
                  .split("\n")
                  .map((line) => `> ${line}`)
                  .join("\n")
            : "_The range has no prompt._"
    );

    lines.push("", "## What happened", "");
    const sections = sectionsOf(slice);
    const shown = sections.slice(-MAX_HAPPENED);

    if (sections.length > shown.length) {
        lines.push(`_${sections.length - shown.length} earlier prompts are left out._`, "");
    }

    for (const section of shown) {
        const sectionTools = section.turns.flatMap((turn) => turn.tools);
        const failed = sectionTools.filter(isFailedTool).length;
        const reply = section.turns.findLast((turn) => turn.role !== "user" && turn.text.trim());
        const summary = [summarizeTools(sectionTools), failed > 0 ? `${failed} failed` : ""]
            .filter(Boolean)
            .join(" · ");
        const heading =
            section.number > 0 ? `**#${start + section.index + 1}** ${section.label}` : `**Before the first prompt**`;
        lines.push(`- ${heading}`);

        if (summary) {
            lines.push(`  - ${summary}`);
        }

        if (reply) {
            lines.push(`  - ${gist(reply.text)}`);
        }
    }

    lines.push("", "## Files touched", "");

    if (changedFiles.length === 0 && readFiles.length === 0) {
        lines.push("_No file reads or edits in this range._");
    }

    for (const file of changedFiles.slice(0, MAX_FILES)) {
        lines.push(fileLine(file));
    }

    if (changedFiles.length > MAX_FILES) {
        lines.push(`- …and ${changedFiles.length - MAX_FILES} more changed files`);
    }

    if (readFiles.length > 0) {
        lines.push(`- Read only: ${readFiles.length} file${readFiles.length === 1 ? "" : "s"}`);
    }

    if (commits.length > 0) {
        lines.push("", "## Commits", "");

        for (const commit of commits) {
            lines.push(`- ${code(commit.sha.slice(0, 10))} ${commit.subject} (${commit.branch})`);
        }
    }

    lines.push("", "## Open items", "");

    if (openItems.length === 0) {
        lines.push("_Nothing open that the transcript shows. Check the goal against the last reply._");
    }

    for (const item of openItems) {
        lines.push(`- [ ] ${item}`);
    }

    return {
        title,
        markdown: `${lines.join("\n")}\n`,
        fromNumber,
        toNumber,
        promptCount: prompts.length,
        goal,
        openItems,
        changedFiles,
        readFiles,
        commits,
    };
}
