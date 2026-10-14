import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";
import { readSessionState } from "./diff/mentions";

/**
 * `tools agents hooks diff log`: what the Bash diff hook decided for each call, told against the
 * call itself. The decision log alone holds the decision, the reason and the file list; the Claude
 * transcript adds the command, what the message really showed, whether the call failed or went to
 * the background, and what Claude Code's own Bash diff drew beside it.
 */

export interface ShownBlock {
    verb: string;
    path: string;
    added: number;
    removed: number;
    /** Added and removed rows that made it into the message. */
    changedShown: number;
}

export interface DiffLogEntry {
    at: string;
    session: string;
    toolUseId: string;
    harness: string;
    /** `emitted`, `noted`, `silent`, `skip`; `failed` for a call with a pre record and no post record. */
    decision: string;
    reason: string;
    files: string[];
    others: string[];
    captured?: number;
    named?: number;
    skipped: string[];
    /** From the transcript, with `--extended`. */
    command?: string;
    /** The subagent transcript the call came from, when it was not the main one. */
    agent?: string;
    background?: boolean;
    errored?: string;
    /** Whether the transcript holds the call's result at all; a call still running has none. */
    finished?: boolean;
    blocks?: ShownBlock[];
    notes?: string[];
    bytes?: number;
    /** Files Claude Code's own Bash diff drew for the call. */
    native?: string[];
}

type LogRecord = Record<string, unknown>;

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function records(path: string): LogRecord[] {
    if (!existsSync(path)) {
        return [];
    }

    const parsed: LogRecord[] = [];

    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.length === 0) {
            continue;
        }

        try {
            const record: unknown = SafeJSON.parse(line, { strict: true });

            if (typeof record === "object" && record !== null) {
                parsed.push(record as LogRecord);
            }
        } catch {
            // Concurrent hooks append to this file, so a torn line is a normal state.
        }
    }

    return parsed;
}

/**
 * The diff decisions since `since` (epoch ms), oldest first. The rotated generation (`<log>.1`) is
 * read too when the window reaches past the current file's first record.
 */
export function readDiffLog(options: { logPath: string; since: number; session?: string }): DiffLogEntry[] {
    let all = records(options.logPath);
    const first = Date.parse(text(all[0]?.at));

    if (!Number.isFinite(first) || first > options.since) {
        all = [...records(`${options.logPath}.1`), ...all];
    }

    const inWindow = all.filter(
        (record) =>
            Date.parse(text(record.at)) >= options.since &&
            typeof record.toolUseId === "string" &&
            (!options.session || text(record.session).startsWith(options.session))
    );
    const pre = new Map(
        inWindow.filter((record) => record.phase === "pre").map((record) => [text(record.toolUseId), record])
    );
    const posted = new Set<string>();
    const entries: DiffLogEntry[] = [];

    for (const record of inWindow) {
        if (record.phase !== "post") {
            continue;
        }

        const id = text(record.toolUseId);
        const before = pre.get(id);

        posted.add(id);
        entries.push({
            at: text(record.at),
            session: text(record.session),
            toolUseId: id,
            harness: text(record.harness),
            decision: text(record.decision),
            reason: text(record.reason),
            files: strings(record.files),
            others: strings(record.others),
            captured: typeof before?.captured === "number" ? before.captured : undefined,
            named: typeof before?.named === "number" ? before.named : undefined,
            skipped: strings(before?.skipped),
        });
    }

    // A failed Bash call gets no PostToolUse, so its pre record is all there is.
    for (const [id, record] of pre) {
        if (!posted.has(id)) {
            entries.push({
                at: text(record.at),
                session: text(record.session),
                toolUseId: id,
                harness: text(record.harness),
                decision: "failed",
                reason: "no post record: the call failed (a failed call gets no post phase) or is still running",
                files: [],
                others: [],
                captured: typeof record.captured === "number" ? record.captured : undefined,
                named: typeof record.named === "number" ? record.named : undefined,
                skipped: strings(record.skipped),
            });
        }
    }

    return entries.sort((first, second) => first.at.localeCompare(second.at));
}

const HEADER = /^(Updated|Added|Deleted) (.+) \(\+(\d+) -(\d+)\)(?: · \w+)?$/;
const NOTE = /^(\d+ file\(s\) changed by others|\d+ dirty file\(s\) changed with no captured|git \w+ moved HEAD)/;
/** The marker column of a body row: six columns of line number, then a space. */
const MARKER = 7;

/** What one hook message showed, read back from the text Claude Code recorded. */
export function readMessage(message: string): { blocks: ShownBlock[]; notes: string[]; bytes: number } {
    const blocks: ShownBlock[] = [];
    const notes: string[] = [];
    let current: ShownBlock | null = null;

    for (const line of stripAnsi(message).split("\n")) {
        const header = HEADER.exec(line);

        if (header) {
            current = {
                verb: header[1] ?? "",
                path: header[2] ?? "",
                added: Number(header[3]),
                removed: Number(header[4]),
                changedShown: 0,
            };
            blocks.push(current);
            continue;
        }

        if (NOTE.test(line)) {
            notes.push(line);
            current = null;
            continue;
        }

        if (current && (line[MARKER] === "+" || line[MARKER] === "-")) {
            current.changedShown += 1;
        }
    }

    return { blocks, notes, bytes: Buffer.byteLength(message) };
}

function claudeDir(): string {
    return env.paths.getClaudeConfigDir() ?? join(homedir(), ".claude");
}

/** The main transcript of a Claude session: the hook's own record of it first, then a search. */
function transcriptOf(session: string): string | null {
    const recorded = readSessionState(session).transcript;

    if (recorded && existsSync(recorded)) {
        return recorded;
    }

    const projects = join(claudeDir(), "projects");

    try {
        for (const project of readdirSync(projects)) {
            const candidate = join(projects, project, `${session}.jsonl`);

            if (existsSync(candidate)) {
                return candidate;
            }
        }
    } catch {
        // No projects folder: no transcript to read.
    }

    return null;
}

/** The main transcript and every subagent transcript beside it. */
function transcriptsOf(session: string): string[] {
    const main = transcriptOf(session);

    if (!main) {
        return [];
    }

    const found = [main];
    const pending = [main.replace(/\.jsonl$/, "/subagents")];

    while (pending.length > 0) {
        const dir = pending.pop() ?? "";

        try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    pending.push(join(dir, entry.name));
                } else if (entry.name.endsWith(".jsonl")) {
                    found.push(join(dir, entry.name));
                }
            }
        } catch {
            // No subagents.
        }
    }

    return found;
}

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

/** Fills the transcript fields of Claude entries in place. */
export function extendFromTranscripts(entries: DiffLogEntry[]): void {
    const bySession = new Map<string, Map<string, DiffLogEntry>>();

    for (const entry of entries) {
        if (entry.harness !== "claude" && entry.harness !== "grok") {
            continue;
        }

        const calls = bySession.get(entry.session) ?? new Map<string, DiffLogEntry>();
        calls.set(entry.toolUseId, entry);
        bySession.set(entry.session, calls);
    }

    for (const [session, calls] of bySession) {
        const files = transcriptsOf(session);

        files.forEach((file, index) => {
            const agent = index === 0 ? undefined : basename(file, ".jsonl");
            let lines: string[];

            try {
                lines = readFileSync(file, "utf8").split("\n");
            } catch {
                return;
            }

            for (const line of lines) {
                if (!line.includes("toolu_") && !line.includes("call_")) {
                    continue;
                }

                let row: unknown;

                try {
                    row = SafeJSON.parse(line, { strict: true });
                } catch {
                    continue;
                }

                readRow(row, calls, agent);
            }
        });
    }
}

function readRow(row: unknown, calls: Map<string, DiffLogEntry>, agent: string | undefined): void {
    const content = field(field(row, "message"), "content");

    for (const item of Array.isArray(content) ? content : []) {
        const type = field(item, "type");

        if (type === "tool_use") {
            const entry = calls.get(text(field(item, "id")));

            if (entry) {
                entry.command = text(field(field(item, "input"), "command"));
                entry.agent = agent;
            }
        } else if (type === "tool_result") {
            const entry = calls.get(text(field(item, "tool_use_id")));
            const result = field(row, "toolUseResult");

            if (!entry) {
                continue;
            }

            entry.finished = true;

            if (field(item, "is_error") === true) {
                const body = field(item, "content");
                entry.errored = (typeof body === "string" ? body : "").split("\n")[0]?.slice(0, 80) ?? "failed";
            }

            entry.background = typeof field(result, "backgroundTaskId") === "string";

            const native = field(field(result, "bashEditDiff"), "files");

            if (Array.isArray(native)) {
                entry.native = native.map((file) => text(field(file, "filePath"))).filter((path) => path.length > 0);
            }
        }
    }

    const attachment = field(row, "attachment");

    if (field(attachment, "type") === "hook_success" && field(attachment, "hookEvent") === "PostToolUse") {
        const entry = calls.get(text(field(attachment, "toolUseID")));
        const stdout = text(field(attachment, "stdout"));

        if (!entry || stdout.length === 0 || entry.blocks) {
            return;
        }

        try {
            const message = text(field(SafeJSON.parse(stdout, { strict: true }), "systemMessage"));

            if (message.length > 0) {
                Object.assign(entry, readMessage(message));
            }
        } catch {
            // Another hook's output on the same event.
        }
    }
}

function localTime(at: string): string {
    // `sv-SE` prints ISO order (`2026-10-14 22:59:30`) in the machine's own time zone.
    return new Date(at).toLocaleString("sv-SE");
}

function excerpt(command: string): string {
    const first = command.trim().split("\n")[0] ?? "";
    const flat = first.replace(/\s+/g, " ");
    const more = command.trim().includes("\n") ? " ⏎…" : "";

    return flat.length > 110 ? `${flat.slice(0, 110)}…${more}` : `${flat}${more}`;
}

function namedBy(command: string | undefined, path: string): boolean {
    return command?.includes(basename(path)) === true;
}

/** The narrative lines for one entry. `extended` adds the transcript facts. */
export function formatEntry(entry: DiffLogEntry, extended: boolean): string[] {
    const who = `${entry.session.slice(0, 8)}${entry.agent ? `/${entry.agent.slice(0, 14)}` : ""}`;
    const ran = entry.command === undefined ? "a Bash call" : `"${excerpt(entry.command)}"`;
    const lines = [`[${localTime(entry.at)}] ${who} ran ${ran}`];

    if (entry.decision === "failed") {
        if (extended && entry.finished !== true) {
            lines.push("  -> no post record yet: the call is still running, or its session ended first");
        } else if (entry.errored) {
            lines.push(`  -> no diff: the call failed (${entry.errored}), and a failed call gets no post phase`);
        } else {
            lines.push(`  -> no diff: ${entry.reason}`);
        }

        return lines;
    }

    if (entry.background) {
        lines.push("  -> the call went to the background, so the post phase ran when it started, not when it ended");
    }

    if (entry.decision === "emitted") {
        const blocks = entry.blocks ?? [];
        const size = entry.bytes === undefined ? "" : `, ${entry.bytes.toLocaleString("en-US")} bytes`;
        lines.push(`  -> emitted a diff block for ${entry.files.length} file(s)${size}:`);

        if (extended && blocks.length > 0) {
            for (const block of blocks) {
                const changed = block.added + block.removed;
                const shown =
                    block.changedShown >= changed
                        ? "every changed line shown"
                        : `${block.changedShown} of ${changed} changed lines shown`;
                const named = namedBy(entry.command, block.path) ? "named by the command" : "NOT named by the command";
                lines.push(
                    `     -> ${block.verb} ${block.path} (+${block.added} -${block.removed}): ${shown}, ${named}`
                );
            }
        } else {
            for (const file of entry.files) {
                lines.push(`     -> ${file}`);
            }
        }
    } else {
        lines.push(
            `  -> ${entry.decision}: ${entry.decision === "noted" ? "one-line notes, no diff block" : "nothing printed"}`
        );
    }

    lines.push(`  -> because: ${entry.reason}`);

    for (const note of entry.notes ?? []) {
        lines.push(`  -> note: ${note}`);
    }

    if (entry.others.length > 0 && !(entry.notes ?? []).some((note) => note.includes("changed by others"))) {
        lines.push(`  -> left to others: ${entry.others.map((path) => basename(path)).join(", ")}`);
    }

    if (extended && entry.skipped.length > 0) {
        lines.push(`  -> capture skipped: ${entry.skipped.join("; ")}`);
    }

    if (entry.native && entry.native.length > 0) {
        lines.push(`  -> Claude Code's own Bash diff showed: ${entry.native.join(", ")}`);
    }

    return lines;
}

/** One count per decision, for the footer. */
export function decisionCounts(entries: DiffLogEntry[]): Map<string, number> {
    const counts = new Map<string, number>();

    for (const entry of entries) {
        counts.set(entry.decision, (counts.get(entry.decision) ?? 0) + 1);
    }

    return counts;
}
