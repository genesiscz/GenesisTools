import { type FailureKind, readFailures, type ToolFailure } from "@genesiscz/utils/cli/failures/record";
import { formatLocalDate } from "@genesiscz/utils/date";
import { daysIn, inWindow, type TimeWindow } from "./window";

export interface FailureFilter {
    kinds?: FailureKind[];
    tools?: string[];
    /** Substring of the command path (`usage sessions`). */
    command?: string;
    /** `claude-code`, `codex`, `grok`, `unknown` (a shell). */
    agent?: string;
    /** Substring of the model, case-insensitive (`sonnet`, `opus-5`, `gpt-6`). */
    model?: string;
    /** A session id or its leading part. */
    session?: string;
    exitCodes?: number[];
    /** Substring of the message, the arguments or the stderr tail, case-insensitive. */
    grep?: string;
    /** Interrupts (Ctrl-C, SIGTERM) are left out unless asked for. */
    interrupts?: boolean;
}

export function matchesFailure(failure: ToolFailure, filter: FailureFilter): boolean {
    if (filter.kinds?.length) {
        if (!filter.kinds.includes(failure.kind)) {
            return false;
        }
    } else if (!filter.interrupts && failure.kind === "interrupt") {
        return false;
    }

    if (filter.tools?.length && !filter.tools.includes(failure.tool)) {
        return false;
    }

    if (filter.command && !(failure.command ?? "").includes(filter.command)) {
        return false;
    }

    if (filter.agent && (failure.caller?.agent ?? "unknown") !== filter.agent) {
        return false;
    }

    if (filter.model && !(failure.caller?.model ?? "").toLowerCase().includes(filter.model.toLowerCase())) {
        return false;
    }

    if (filter.session && !(failure.caller?.sessionId ?? "").startsWith(filter.session)) {
        return false;
    }

    if (filter.exitCodes?.length && !filter.exitCodes.includes(failure.exitCode ?? -1)) {
        return false;
    }

    if (filter.grep) {
        const needle = filter.grep.toLowerCase();
        const haystack = [failure.message ?? "", failure.argv.join(" "), failure.stderrTail ?? ""].join("\n");
        if (!haystack.toLowerCase().includes(needle)) {
            return false;
        }
    }

    return true;
}

/**
 * The failures in the window that pass the filter, oldest first. With a positive `limit`, only the newest that many
 * are kept while reading, so a long window holds no more records than it shows; a command that counts all of them
 * passes none.
 */
export function loadFailures({
    window,
    filter = {},
    dir,
    limit,
}: {
    window: TimeWindow;
    filter?: FailureFilter;
    dir?: string;
    limit?: number;
}): ToolFailure[] {
    const days = daysIn(window);
    const found: ToolFailure[] = [];
    const bound = limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : null;

    for (const failure of readFailures({ fromDay: days[0], toDay: days.at(-1) ?? days[0], dir })) {
        if (inWindow(failure.at, window) && matchesFailure(failure, filter)) {
            found.push(failure);
            if (bound !== null && found.length > bound) {
                found.shift();
            }
        }
    }

    return found;
}

export const GROUP_KEYS = ["tool", "kind", "command", "model", "agent", "message", "exit", "day", "session"] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

export function isGroupKey(value: string): value is GroupKey {
    return GROUP_KEYS.some((key) => key === value);
}

function keyOf(failure: ToolFailure, by: GroupKey): string {
    switch (by) {
        case "tool":
            return failure.tool;
        case "kind":
            return failure.kind;
        case "command":
            return failure.command ?? failure.tool;
        case "model":
            return failure.caller?.model ?? "(none)";
        case "agent":
            return failure.caller?.agent ?? "unknown";
        case "message":
            return failure.message ?? "(no message)";
        case "exit":
            return String(failure.exitCode ?? "-");
        case "day":
            return formatLocalDate(new Date(failure.at));
        case "session":
            return failure.caller?.sessionId ?? "(none)";
    }
}

export interface FailureGroup {
    key: string[];
    count: number;
    lastAt: string;
    lastId: string;
    models: string[];
    sessions: number;
}

/** Counts by the given keys, most frequent first. */
export function groupFailures(failures: ToolFailure[], by: GroupKey[]): FailureGroup[] {
    const groups = new Map<string, FailureGroup & { sessionIds: Set<string> }>();

    for (const failure of failures) {
        const key = by.map((name) => keyOf(failure, name));
        const id = key.join("\u0000");
        const group = groups.get(id) ?? {
            key,
            count: 0,
            lastAt: failure.at,
            lastId: failure.id,
            models: [],
            sessions: 0,
            sessionIds: new Set<string>(),
        };
        group.count++;
        if (failure.at >= group.lastAt) {
            group.lastAt = failure.at;
            group.lastId = failure.id;
        }

        const model = failure.caller?.model;
        if (model && !group.models.includes(model)) {
            group.models.push(model);
        }

        if (failure.caller?.sessionId) {
            group.sessionIds.add(failure.caller.sessionId);
        }

        groups.set(id, group);
    }

    return [...groups.values()]
        .map(({ sessionIds, ...group }) => ({ ...group, sessions: sessionIds.size }))
        .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
}

export interface UsageGap {
    tool: string;
    command: string;
    message: string;
    count: number;
    models: string[];
    /** Up to three distinct command lines that hit it, newest first. */
    examples: string[];
}

/**
 * The command lines tools refused, grouped by what they refused: each row is a place where the help, an alias or a
 * clearer error would have saved a retry. Agents' misuses count the same as a person's.
 */
export function usageGaps(failures: ToolFailure[]): UsageGap[] {
    const usage = failures.filter((failure) => failure.kind === "usage");
    const gaps = new Map<string, UsageGap>();

    for (const failure of [...usage].reverse()) {
        const command = failure.command ?? failure.tool;
        const message = failure.message ?? "(no message)";
        const id = `${command}\u0000${message}`;
        const gap = gaps.get(id) ?? { tool: failure.tool, command, message, count: 0, models: [], examples: [] };
        gap.count++;
        const model = failure.caller?.model;
        if (model && !gap.models.includes(model)) {
            gap.models.push(model);
        }

        const example = `tools ${failure.tool} ${failure.argv.join(" ")}`.trim();
        if (gap.examples.length < 3 && !gap.examples.includes(example)) {
            gap.examples.push(example);
        }

        gaps.set(id, gap);
    }

    return [...gaps.values()].sort((a, b) => b.count - a.count);
}
