import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts";
import { shortModel } from "./native";
import { isFailedTool } from "./tool-kind";
import {
    type CallTokens,
    EXPENSIVE_TURNS,
    type NativeScan,
    type TokenTotals,
    type ToolStat,
    type TurnCost,
} from "./types";

/** A model call with the model that made it, ready to price. */
export interface PricedCallInput extends CallTokens {
    model: string | null;
    at: string | null;
}

/** USD for one call at list price, or null when the model has no known price. */
export type CallPricer = (call: PricedCallInput) => number | null;

export interface TurnCostOptions {
    turns: readonly TranscriptTurn[];
    /** Claude's native file: per-call usage and models. Absent for other providers. */
    native?: NativeScan | null;
    /** The model to price envelope usage with when a call names none (Codex, Grok). */
    defaultModel?: string | null;
    price: CallPricer;
}

export interface TurnCostResult {
    turns: TurnCost[];
    totals: TokenTotals;
    /** True when every call that used tokens had a price. */
    priced: boolean;
}

/** A gap longer than this is the reader walking away, not a tool running (the Swift rows use the same cut). */
const MAX_TOOL_GAP_MS = 3_600_000;
const LABEL_CHARS = 90;

function emptyTotals(): TokenTotals {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        modelCalls: 0,
        costUsd: 0,
    };
}

function usesTokens(call: CallTokens): boolean {
    return call.input + call.output + call.cacheRead + call.cacheWrite + call.reasoning > 0;
}

function millis(iso: string | null | undefined): number | null {
    if (!iso) {
        return null;
    }

    const value = Date.parse(iso);
    return Number.isFinite(value) ? value : null;
}

/** The prompt's first non-empty line, clipped. */
export function promptLabel(text: string, max = LABEL_CHARS): string {
    const line =
        text
            .split("\n")
            .map((part) => part.trim())
            .find((part) => part.length > 0) ?? "";
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface Section {
    number: number;
    index: number;
    turnId: string;
    label: string;
    turns: TranscriptTurn[];
}

/** Turns grouped per user prompt; work before the first prompt is a section numbered 0. */
export function sectionsOf(turns: readonly TranscriptTurn[]): Section[] {
    const sections: Section[] = [];

    for (const [index, turn] of turns.entries()) {
        const current = sections.at(-1);

        if (turn.role === "user") {
            sections.push({ number: index + 1, index, turnId: turn.id, label: promptLabel(turn.text), turns: [turn] });
            continue;
        }

        if (!current) {
            sections.push({ number: 0, index, turnId: turn.id, label: "Before the first prompt", turns: [turn] });
            continue;
        }

        current.turns.push(turn);
    }

    return sections;
}

interface Call extends PricedCallInput {
    section: number;
}

/**
 * Every model call, assigned to its section. With a native scan, calls come from the file (one per
 * `message.id`, thinking-only calls included) and a call belongs to the section whose first line
 * comes at or before it; otherwise each assistant turn's envelope usage is one call.
 */
function callsOf(sections: readonly Section[], options: TurnCostOptions): Call[] {
    const native = options.native;
    const starts = native ? sections.map((section) => native.ordinals.get(section.turnId)) : [];

    if (native && starts.length > 0 && starts.every((start) => start !== undefined)) {
        const known = starts as number[];
        let section = 0;
        // Sections and calls are both in file order: the last start at or before a call owns it.
        return native.calls.map((call) => {
            while (section + 1 < known.length && (known[section + 1] ?? Number.POSITIVE_INFINITY) <= call.ordinal) {
                section += 1;
            }

            return { ...call, section };
        });
    }

    const calls: Call[] = [];

    for (const [section, entry] of sections.entries()) {
        for (const turn of entry.turns) {
            if (turn.role === "user" || !turn.usage) {
                continue;
            }

            calls.push({
                section,
                model: options.defaultModel ?? null,
                at: turn.at,
                input: turn.usage.inputTokens ?? 0,
                output: turn.usage.outputTokens ?? 0,
                cacheRead: turn.usage.cacheReadTokens ?? 0,
                cacheWrite: 0,
                reasoning: turn.usage.reasoningTokens ?? 0,
            });
        }
    }

    return calls;
}

function addCall(totals: TokenTotals, call: Call, cost: number | null): void {
    totals.inputTokens += call.input;
    totals.outputTokens += call.output;
    totals.cacheReadTokens += call.cacheRead;
    totals.cacheWriteTokens += call.cacheWrite;
    totals.reasoningTokens += call.reasoning;
    totals.modelCalls += 1;

    if (cost === null) {
        totals.costUsd = null;
    } else if (totals.costUsd !== null) {
        totals.costUsd += cost;
    }
}

/** Tokens that cost real money, for ranking an unpriced session: cache reads are a tenth of input. */
function billableTokens(turn: TokenTotals): number {
    return turn.inputTokens + turn.cacheWriteTokens + turn.outputTokens;
}

/** Per-prompt tokens and cost, with the `EXPENSIVE_TURNS` most expensive ranked 1.. */
export function buildTurnCosts(options: TurnCostOptions): TurnCostResult {
    const sections = sectionsOf(options.turns);
    const perSection = sections.map(() => ({ totals: emptyTotals(), models: new Set<string>() }));
    const totals = emptyTotals();
    let priced = true;

    for (const call of callsOf(sections, options)) {
        const cost = usesTokens(call) ? options.price(call) : 0;

        if (cost === null) {
            priced = false;
        }

        const slot = perSection[call.section];

        if (!slot) {
            continue;
        }

        addCall(slot.totals, call, cost);
        addCall(totals, call, cost);

        if (call.model) {
            slot.models.add(shortModel(call.model));
        }
    }

    const turns: TurnCost[] = sections.map((section, i) => {
        const tools = section.turns.flatMap((turn) => turn.tools);
        const first = millis(section.turns[0]?.at);
        const last = millis(section.turns.findLast((turn) => turn.at)?.at);
        const slot = perSection[i] ?? { totals: emptyTotals(), models: new Set<string>() };
        return {
            ...slot.totals,
            number: section.number,
            index: section.index,
            turnId: section.turnId,
            label: section.label,
            at: section.turns[0]?.at ?? null,
            durationMs: first !== null && last !== null && last > first ? last - first : null,
            models: [...slot.models],
            toolCount: tools.length,
            errorCount: tools.filter(isFailedTool).length,
            rank: null,
        };
    });

    const measure = (turn: TurnCost): number => (priced ? (turn.costUsd ?? 0) : billableTokens(turn));
    const ranked = turns
        .map((turn, position) => ({ position, value: measure(turn) }))
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value || a.position - b.position)
        .slice(0, EXPENSIVE_TURNS);

    for (const [rank, entry] of ranked.entries()) {
        const turn = turns[entry.position];

        if (turn) {
            turn.rank = rank + 1;
        }
    }

    return { turns, totals, priced };
}

export interface ToolStatsOptions {
    turns: readonly TranscriptTurn[];
    native?: NativeScan | null;
}

interface Measured {
    ms: number;
    exact: boolean;
}

/** Exact from the native file's result line when both ends are known; else the gap to the next entry. */
function durationOf(options: {
    toolId: string;
    turnAt: string | null;
    nextAt: string | null;
    native?: NativeScan | null;
}): Measured | null {
    const timing = options.native?.toolTimings.get(options.toolId);
    const started = millis(timing?.startedAt);
    const ended = millis(timing?.endedAt);

    if (started !== null && ended !== null && ended >= started) {
        return { ms: ended - started, exact: true };
    }

    const at = millis(options.turnAt);
    const next = millis(options.nextAt);

    if (at !== null && next !== null && next >= at && next - at < MAX_TOOL_GAP_MS) {
        return { ms: next - at, exact: false };
    }

    return null;
}

/** Per tool name: calls, failures, total and slowest duration. Most used first. */
export function buildToolStats(options: ToolStatsOptions): ToolStat[] {
    const stats = new Map<string, ToolStat & { anyEstimate: boolean }>();
    const turns = options.turns;
    // The next timestamped entry after each turn, filled from the end in one pass.
    const nextAts: (string | null)[] = new Array(turns.length).fill(null);

    for (let i = turns.length - 2; i >= 0; i -= 1) {
        nextAts[i] = turns[i + 1]?.at ?? nextAts[i + 1] ?? null;
    }

    for (const [index, turn] of turns.entries()) {
        if (turn.tools.length === 0) {
            continue;
        }

        const nextAt = nextAts[index] ?? null;

        for (const tool of turn.tools) {
            const stat = stats.get(tool.name) ?? {
                name: tool.name,
                count: 0,
                failures: 0,
                failureRate: 0,
                totalMs: 0,
                slowestMs: null,
                slowestToolId: null,
                slowestTurnIndex: null,
                timing: "exact" as const,
                anyEstimate: false,
            };
            stat.count += 1;

            if (isFailedTool(tool)) {
                stat.failures += 1;
            }

            const pending = tool.result === null && index === turns.length - 1;
            const measured = pending
                ? null
                : durationOf({ toolId: tool.id, turnAt: turn.at, nextAt, native: options.native });

            if (measured) {
                stat.totalMs += measured.ms;
                stat.anyEstimate ||= !measured.exact;

                if (stat.slowestMs === null || measured.ms > stat.slowestMs) {
                    stat.slowestMs = measured.ms;
                    stat.slowestToolId = tool.id;
                    stat.slowestTurnIndex = turn.index ?? index;
                }
            }

            stats.set(tool.name, stat);
        }
    }

    return [...stats.values()]
        .map(({ anyEstimate, ...stat }) => ({
            ...stat,
            failureRate: stat.count > 0 ? stat.failures / stat.count : 0,
            timing: anyEstimate ? ("upper-bound" as const) : ("exact" as const),
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
