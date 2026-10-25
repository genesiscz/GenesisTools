// The rows of the agents panel under the prompt (`◯ general-purpose  Reading foo.ts  4s · ↓ 58k tokens`). The
// engine draws them itself, with no `ui.render` component, and puts the agent's type on the left, so a mod cannot
// reach them. Claude Code's `subagentStatusLine` setting can: its command gets every listed subagent as JSON on stdin
// and prints one `{"id","content"}` line per row. `tools agents hooks install` wires
// `src/agents/bin/hook-subagent-line.ts` there while `mods.agentRow.enabled` is on; this file is what it prints:
// `general-purpose · sonnet-5-5  Reading foo.ts  4s · ↓ 58k tokens`.
//
// Engine facts (Claude Code 2.1.296, read from its bundle and live-probed 2026-10-25):
// - The command runs 300 ms after the set of listed subagents changes, then every 5 s, with a 5 s timeout. So the
//   time on a row moves in 5 s steps, where the engine's own row counts each second.
// - A row with a line draws ONLY that content after its glyph: the engine's time and token column goes too, so the
//   content carries them. A row without a line keeps the engine's row, and an empty content hides the row.
// - The engine dims or bolds the whole row for focus and selection, so the content is plain text: an ANSI reset in
//   it would undo that.
// - The payload has no end time: a finished agent's time ends when this command first saw it finished.
// No engine types here: the CLI's command imports this file.

import { bareDescription, type Format, modelLabel, withEffort } from "./model-label";

export interface RowTask {
    id: string;
    /** The name a named agent or teammate got; the engine shows it in place of the type. */
    name?: string;
    agentType?: string;
    status?: string;
    description?: string;
    /** What the agent does now (the engine's activity summary), else its description. */
    label?: string;
    startTime?: number;
    model?: string;
    /** The reasoning effort the agent runs at (`xhigh`), when the engine names one. */
    effort?: string;
    tokenCount?: number;
}

export interface RowInput {
    sessionId?: string;
    /** The width the engine leaves for a row's content, past its glyph. */
    columns: number;
    tasks: RowTask[];
}

export interface RowOptions {
    format: Format;
    /** Name the effort beside the model: `O5.5(xhigh)` (`mods.agentRow.effort`). */
    effort: boolean;
    now: number;
    /** When each finished agent was first seen finished (`finishedAt`). */
    ends: Record<string, number>;
    /** Terminal cells of a string: `Bun.stringWidth`. */
    width: (text: string) => number;
}

const FINISHED = new Set(["completed", "failed", "killed"]);
const GAP = "  ";

function text(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The payload the engine sends, narrowed; `undefined` when it is not one. */
export function rowInput(payload: unknown): RowInput | undefined {
    if (typeof payload !== "object" || payload === null || !("tasks" in payload) || !Array.isArray(payload.tasks)) {
        return undefined;
    }

    const tasks: RowTask[] = [];

    for (const raw of payload.tasks) {
        if (typeof raw !== "object" || raw === null) {
            continue;
        }

        const task = new Map<string, unknown>(Object.entries(raw));
        const id = text(task.get("id"));

        if (!id) {
            continue;
        }

        tasks.push({
            id,
            name: text(task.get("name")),
            agentType: text(task.get("agentType")),
            status: text(task.get("status")),
            description: text(task.get("description")),
            label: text(task.get("label")),
            startTime: count(task.get("startTime")),
            model: text(task.get("model")),
            effort: text(task.get("effort")),
            tokenCount: count(task.get("tokenCount")),
        });
    }

    const columns = "columns" in payload ? count(payload.columns) : undefined;
    const sessionId = "session_id" in payload ? text(payload.session_id) : undefined;

    return { sessionId, columns: columns ?? 80, tasks };
}

/** The finished agents of `input` with the time each was first seen finished; the agents no longer listed go. */
export function finishedAt(input: RowInput, held: Record<string, number>, now: number): Record<string, number> {
    const ends: Record<string, number> = {};

    for (const task of input.tasks) {
        if (task.status && FINISHED.has(task.status)) {
            ends[task.id] = held[task.id] ?? now;
        }
    }

    return ends;
}

/** The engine's own duration form: `4s`, `1m 5s`, `1h 2m 3s`, `1d 2h 3m`. */
export function duration(ms: number): string {
    if (ms < 60_000) {
        return `${Math.floor(Math.max(0, ms) / 1000)}s`;
    }

    let days = Math.floor(ms / 86_400_000);
    let hours = Math.floor((ms % 86_400_000) / 3_600_000);
    let minutes = Math.floor((ms % 3_600_000) / 60_000);
    let seconds = Math.round((ms % 60_000) / 1000);

    if (seconds === 60) {
        seconds = 0;
        minutes++;
    }

    if (minutes === 60) {
        minutes = 0;
        hours++;
    }

    if (hours === 24) {
        hours = 0;
        days++;
    }

    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    return `${minutes}m ${seconds}s`;
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** `↓ 58.2k tokens`, as the engine writes it; nothing before the first token. */
function tokens(n: number | undefined): string {
    return n && n > 0 ? `↓ ${COMPACT.format(n).toLowerCase()} tokens` : "";
}

/** The right column: the time the agent ran (to its end once finished) and its tokens. */
function statusOf(task: RowTask, options: RowOptions): string {
    const end = task.status && FINISHED.has(task.status) ? options.ends[task.id] : options.now;
    const time = task.startTime !== undefined && end !== undefined ? duration(end - task.startTime) : "";

    return [time, tokens(task.tokenCount)].filter(Boolean).join(" · ");
}

/** The left column: the name or type, then the model and its effort. */
function labelOf(task: RowTask, options: RowOptions): string {
    const who = task.name || task.agentType || "agent";

    if (!task.model) {
        return who;
    }

    const model = modelLabel(task.model, options.format);

    return `${who} · ${withEffort(model, options.effort ? task.effort : undefined, options.format)}`;
}

/** One line of plain text: control characters and runs of white space become one space. */
function oneLine(value: string): string {
    return value
        .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** `value` cut to `cells` terminal cells, with `…` where it was cut. */
function fit(value: string, cells: number, width: (text: string) => number): string {
    if (cells <= 0) {
        return "";
    }

    if (width(value) <= cells) {
        return value;
    }

    let out = "";
    let used = 0;

    for (const char of value) {
        const w = width(char);

        if (used + w > cells - 1) {
            break;
        }

        out += char;
        used += w;
    }

    return `${out}…`;
}

function padEnd(value: string, cells: number, width: (text: string) => number): string {
    return value + " ".repeat(Math.max(0, cells - width(value)));
}

/**
 * The content of each row: the label column as wide as the widest label (at most half the row), the activity,
 * and the time and tokens at the right edge, as the engine lays out its own row.
 */
export function agentRows(input: RowInput, options: RowOptions): { id: string; content: string }[] {
    const { width } = options;
    // One cell spare: the engine's width is its own estimate, and a nested agent's tree connector takes more.
    const columns = Math.max(0, input.columns - 1);
    const rows = input.tasks.map((task) => ({
        id: task.id,
        label: oneLine(labelOf(task, options)),
        activity: oneLine(bareDescription(task.label || task.description || "")),
        status: statusOf(task, options),
    }));
    const labelCells = Math.min(
        Math.max(0, ...rows.map((row) => width(row.label))),
        Math.max(8, Math.floor(columns / 2))
    );
    const statusCells = Math.max(0, ...rows.map((row) => width(row.status)));

    return rows.map((row) => {
        const label = padEnd(fit(row.label, labelCells, width), labelCells, width);
        const status = " ".repeat(Math.max(0, statusCells - width(row.status))) + row.status;
        const room = columns - labelCells - GAP.length - (statusCells > 0 ? statusCells + 1 : 0);

        if (room <= 0) {
            return { id: row.id, content: `${label} ${row.status}`.trimEnd() };
        }

        const activity = padEnd(fit(row.activity, room, width), room, width);

        return { id: row.id, content: `${label}${GAP}${activity}${statusCells > 0 ? ` ${status}` : ""}`.trimEnd() };
    });
}
