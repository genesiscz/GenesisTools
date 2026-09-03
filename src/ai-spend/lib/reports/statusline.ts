import { SafeJSON } from "@genesiscz/utils/json";
import type { PricingTable } from "../types";
import { identifySessionBlocks } from "./blocks";
import { zonedDay } from "./dates";
import { asRecord, asString } from "./jsonl";
import { pricedEventCost } from "./load";
import type { CostMode, SpendEvent } from "./types";

export interface StatuslineHook {
    session_id: string;
    transcript_path?: string;
    model?: { id?: string; display_name?: string };
    cost?: { total_cost_usd?: number };
    effort?: { level?: string };
    context_window?: { total_input_tokens?: number; context_window_size?: number };
}

export interface StatuslineOptions {
    timezone: string;
    now: Date;
    pricing: PricingTable;
    mode: CostMode;
    costSource: "auto" | "ccusage" | "cc" | "both";
    visualBurnRate: "off" | "emoji" | "text" | "emoji-text";
}

export function parseStatuslineHook(raw: string): StatuslineHook | null {
    const trimmed = raw.trim();

    if (!trimmed) {
        return null;
    }

    try {
        const parsed = SafeJSON.parse(trimmed, { strict: true });
        const record = asRecord(parsed);

        if (!record) {
            return null;
        }

        const sessionId = asString(record.session_id) ?? asString(record.sessionId);

        if (!sessionId) {
            return null;
        }

        const model = asRecord(record.model);
        const cost = asRecord(record.cost);
        const effort = asRecord(record.effort);
        const context = asRecord(record.context_window) ?? asRecord(record.contextWindow);
        return {
            session_id: sessionId,
            transcript_path: asString(record.transcript_path) ?? asString(record.transcriptPath),
            model: model
                ? { id: asString(model.id), display_name: asString(model.display_name) ?? asString(model.displayName) }
                : undefined,
            cost: cost
                ? { total_cost_usd: typeof cost.total_cost_usd === "number" ? cost.total_cost_usd : undefined }
                : undefined,
            effort: effort ? { level: asString(effort.level) } : undefined,
            context_window: context
                ? {
                      total_input_tokens:
                          typeof context.total_input_tokens === "number" ? context.total_input_tokens : undefined,
                      context_window_size:
                          typeof context.context_window_size === "number" ? context.context_window_size : undefined,
                  }
                : undefined,
        };
    } catch {
        return null;
    }
}

function usd(value: number | undefined): string {
    if (value === undefined) {
        return "N/A";
    }

    return `$${value.toFixed(2)}`;
}

function formatRemaining(minutes: number): string {
    const rounded = Math.round(minutes);
    const hours = Math.floor(rounded / 60);
    const mins = rounded % 60;
    return `${hours}h ${mins}m left`;
}

export function renderStatusline(hook: StatuslineHook, events: SpendEvent[], options: StatuslineOptions): string {
    const today = zonedDay(options.now.toISOString(), options.timezone);
    const costOf = (event: SpendEvent): number => pricedEventCost(event, options.pricing, options.mode);
    const sessionCost = events
        .filter((event) => event.sessionId === hook.session_id)
        .reduce((sum, event) => sum + costOf(event), 0);
    const todayCost = events
        .filter((event) => zonedDay(event.timestamp, options.timezone) === today)
        .reduce((sum, event) => sum + costOf(event), 0);
    const hookCost = hook.cost?.total_cost_usd;
    let sessionDisplay: string;

    if (options.costSource === "cc") {
        sessionDisplay = usd(hookCost);
    } else if (options.costSource === "ccusage") {
        sessionDisplay = usd(sessionCost);
    } else if (options.costSource === "both") {
        sessionDisplay = `(${usd(hookCost)} cc / ${usd(sessionCost)} ccusage)`;
    } else {
        sessionDisplay = usd(hookCost ?? sessionCost);
    }

    const blocks = identifySessionBlocks(events, 5, options.now.getTime(), costOf);
    const active = blocks.find((block) => block.isActive && !block.isGap);
    let blockInfo = "No active block";
    let burn = "";

    if (active) {
        const remaining = Math.max((Date.parse(active.endTime) - options.now.getTime()) / 60_000, 0);
        blockInfo = `${usd(active.costUSD)} block (${formatRemaining(remaining)})`;

        if (active.burnRate && options.visualBurnRate !== "off") {
            const rate = active.burnRate.tokensPerMinuteForIndicator;
            const status =
                rate < 2000
                    ? (["🟢", "Normal"] as const)
                    : rate < 5000
                      ? (["⚠️", "Moderate"] as const)
                      : (["🚨", "High"] as const);
            const segments = [`${usd(active.burnRate.costPerHour)}/hr`];

            if (options.visualBurnRate === "emoji" || options.visualBurnRate === "emoji-text") {
                segments.push(status[0]);
            }

            if (options.visualBurnRate === "text" || options.visualBurnRate === "emoji-text") {
                segments.push(`(${status[1]})`);
            }

            burn = ` | 🔥 ${segments.join(" ")}`;
        } else if (active.burnRate) {
            burn = ` | 🔥 ${usd(active.burnRate.costPerHour)}/hr`;
        }
    }

    let context = "N/A";
    const totalInput = hook.context_window?.total_input_tokens;
    const windowSize = hook.context_window?.context_window_size;

    if (typeof totalInput === "number" && typeof windowSize === "number" && windowSize > 0) {
        const pct = Math.round((totalInput / windowSize) * 100);
        context = `${totalInput.toLocaleString()} (${pct}%)`;
    }

    const modelLabel = hook.model?.display_name ?? hook.model?.id ?? "unknown";
    const effort = hook.effort?.level ? ` (${hook.effort.level})` : "";
    return `🤖 ${modelLabel}${effort} | 💰 ${sessionDisplay} session / ${usd(todayCost)} today / ${blockInfo}${burn} | 🧠 ${context}`;
}
