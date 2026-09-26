import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TranscriptTool, TranscriptTurn } from "@genesiscz/utils/ai/transcripts";
import { formatDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { isFailedTool, keyArgument, toolDisplayName } from "./tool-kind";
import type { StuckThresholds, StuckVerdict } from "./types";

// The stuck-agent detector: a running session whose last tool call has waited too long, or that
// keeps making the same call. Pure over the transcript's tail, so the hub's badge, the session
// header and `tools hub stuck` all print the same verdict. Thresholds live in
// `~/.genesis-tools/hub/stuck.json` (`tools hub stuck config`).

const log = logger.child({ component: "hub/stuck" });

export function defaultStuckThresholds(): StuckThresholds {
    return {
        toolMinutes: 10,
        repeats: 5,
        maxAgeHours: 6,
        activeMinutes: 30,
        ignoreLongTools: ["Agent", "Task", "Workflow", "Monitor"],
        ignoreRepeatTools: ["BashOutput", "TaskOutput"],
    };
}

export const STUCK_LIMITS = {
    toolMinutes: { min: 1, max: 24 * 60 },
    repeats: { min: 2, max: 100 },
    maxAgeHours: { min: 1, max: 7 * 24 },
    activeMinutes: { min: 1, max: 24 * 60 },
} as const;

type NumericThreshold = keyof typeof STUCK_LIMITS;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function names(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
        return fallback;
    }

    return value.filter((name): name is string => typeof name === "string" && name.trim() !== "");
}

function clamp(key: NumericThreshold, value: number): number {
    const { min, max } = STUCK_LIMITS[key];
    return Math.min(max, Math.max(min, Math.round(value)));
}

/** A hand-edited file onto complete thresholds: wrong types fall back, numbers are clamped. */
export function normalizeStuckThresholds(raw: unknown): StuckThresholds {
    const base = defaultStuckThresholds();

    if (!isRecord(raw)) {
        return base;
    }

    const number = (key: NumericThreshold): number => {
        const value = raw[key];
        return typeof value === "number" && Number.isFinite(value) ? clamp(key, value) : base[key];
    };

    return {
        toolMinutes: number("toolMinutes"),
        repeats: number("repeats"),
        maxAgeHours: number("maxAgeHours"),
        activeMinutes: number("activeMinutes"),
        ignoreLongTools: names(raw.ignoreLongTools, base.ignoreLongTools),
        ignoreRepeatTools: names(raw.ignoreRepeatTools, base.ignoreRepeatTools),
    };
}

/** A CLI number flag: a whole number inside the limits, or an error naming them. Never clamped. */
export function parseThresholdFlag(key: NumericThreshold, flag: string, value: string): number {
    const parsed = Number(value);
    const { min, max } = STUCK_LIMITS[key];

    if (value.trim() === "" || !Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${flag} takes a whole number from ${min} to ${max}, got ${value}`);
    }

    return parsed;
}

export function stuckConfigPath(dir = new Storage("hub").getBaseDir()): string {
    return join(dir, "stuck.json");
}

export function readStuckThresholds(path = stuckConfigPath()): StuckThresholds {
    if (!existsSync(path)) {
        return defaultStuckThresholds();
    }

    try {
        return normalizeStuckThresholds(SafeJSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
        log.warn({ err, path }, "stuck thresholds unreadable; using the defaults");
        return defaultStuckThresholds();
    }
}

/** Read, change and write back under a lock. `reset` starts from the defaults. */
export async function updateStuckThresholds(
    change: Partial<StuckThresholds> & { reset?: boolean },
    path = stuckConfigPath()
): Promise<StuckThresholds> {
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, async () => {
        const { reset, ...fields } = change;
        const base = reset ? defaultStuckThresholds() : readStuckThresholds(path);
        const next = normalizeStuckThresholds({ ...base, ...fields });
        atomicWriteFileSync(path, `${SafeJSON.stringify(next, null, 2)}\n`);
        log.debug({ path, change }, "stuck thresholds updated");
        return next;
    });
}

function millis(iso: string | null | undefined): number | null {
    if (!iso) {
        return null;
    }

    const value = Date.parse(iso);
    return Number.isFinite(value) ? value : null;
}

function spoken(ms: number): string {
    return formatDuration(ms, "ms", "tiered");
}

export interface StuckInput {
    /** The transcript, or its tail: the last prompt and everything after it is enough. */
    turns: readonly TranscriptTurn[];
    /** Session-wide index of `turns[0]`, when `turns` is a tail. */
    turnOffset?: number;
    now: number;
    thresholds: StuckThresholds;
    /** Tool id → its full input (`toolInputKeys`); without one, name plus key argument is the call. */
    inputKeys?: ReadonlyMap<string, string>;
    /** The transcript recorded an end. */
    terminated?: boolean;
}

interface Call {
    tool: TranscriptTool;
    turnIndex: number;
    at: string | null;
}

/** The calls after the last user prompt, oldest first. */
function trailingCalls(turns: readonly TranscriptTurn[], offset: number): Call[] {
    const calls: Call[] = [];

    for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];

        if (!turn || turn.role === "user") {
            break;
        }

        const index = turn.index ?? offset + i;
        calls.unshift(...turn.tools.map((tool) => ({ tool, turnIndex: index, at: turn.at })));
    }

    return calls;
}

function signature(tool: TranscriptTool, inputKeys?: ReadonlyMap<string, string>): string {
    const input = inputKeys?.get(tool.id) ?? tool.inputPreview.replace(/\s+/g, " ").trim();
    return `${tool.name}\u0000${input}`;
}

function longToolVerdict(input: StuckInput): StuckVerdict | null {
    const offset = input.turnOffset ?? 0;
    const lastIndex = input.turns.length - 1;
    const last = input.turns[lastIndex];

    if (!last || last.role === "user") {
        return null;
    }

    const ignored = new Set(input.thresholds.ignoreLongTools);
    const pending = last.tools.findLast((tool) => tool.result === null && !ignored.has(tool.name));
    const started = millis(last.at);

    if (!pending || started === null) {
        return null;
    }

    const elapsed = input.now - started;

    if (elapsed < input.thresholds.toolMinutes * 60_000 || elapsed > input.thresholds.maxAgeHours * 3_600_000) {
        return null;
    }

    const name = toolDisplayName(pending.name);
    return {
        kind: "long-tool",
        tool: pending.name,
        argument: keyArgument(pending),
        detail: `${name} has waited ${spoken(elapsed)} for its result (a long run, a hung command, or a permission prompt nobody answered)`,
        since: last.at,
        elapsedMs: elapsed,
        count: 1,
        failures: 0,
        turnIndex: last.index ?? offset + lastIndex,
        toolId: pending.id,
    };
}

function repeatVerdict(input: StuckInput): StuckVerdict | null {
    const calls = trailingCalls(input.turns, input.turnOffset ?? 0);
    const last = calls.at(-1);

    if (!last || input.thresholds.ignoreRepeatTools.includes(last.tool.name)) {
        return null;
    }

    const wanted = signature(last.tool, input.inputKeys);
    let run = 0;

    for (let i = calls.length - 1; i >= 0; i -= 1) {
        const call = calls[i];

        if (!call || signature(call.tool, input.inputKeys) !== wanted) {
            break;
        }

        run += 1;
    }

    const lastAt = millis(last.at);

    if (
        run < input.thresholds.repeats ||
        lastAt === null ||
        input.now - lastAt > input.thresholds.activeMinutes * 60_000
    ) {
        return null;
    }

    const loop = calls.slice(calls.length - run);
    const first = loop[0] ?? last;
    const failures = loop.filter((call) => isFailedTool(call.tool)).length;
    const firstAt = millis(first.at);
    const name = toolDisplayName(last.tool.name);
    const failed = failures === run ? ", every one failed" : failures > 0 ? `, ${failures} failed` : "";
    return {
        kind: "repeat-loop",
        tool: last.tool.name,
        argument: keyArgument(last.tool),
        detail: `${name} ran the same call ${run} times in a row${failed}`,
        since: first.at,
        elapsedMs: firstAt === null ? null : input.now - firstAt,
        count: run,
        failures,
        turnIndex: first.turnIndex,
        toolId: first.tool.id,
    };
}

/** A waiting call wins over a loop: it is what the agent is doing right now. */
export function stuckVerdict(input: StuckInput): StuckVerdict | null {
    if (input.terminated) {
        return null;
    }

    return longToolVerdict(input) ?? repeatVerdict(input);
}
