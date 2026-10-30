import { parseStatuslineInput, type StatuslineInput } from "@genesiscz/utils/agents/hooks/statusline-input";
import type { PricingTable } from "../types";
import { identifySessionBlocks } from "./blocks";
import { zonedDay } from "./dates";
import { pricedEventCost } from "./load";
import type { CostMode, SpendEvent } from "./types";

/** Claude Code's statusline input with the session id this report needs. */
export type StatuslineHook = StatuslineInput & { sessionId: string };

export interface StatuslineOptions {
    timezone: string;
    now: Date;
    pricing: PricingTable;
    mode: CostMode;
    costSource: "auto" | "ccusage" | "cc" | "both";
    visualBurnRate: "off" | "emoji" | "text" | "emoji-text";
}

export function parseStatuslineHook(raw: string): StatuslineHook | null {
    const input = parseStatuslineInput(raw);
    const sessionId = input?.sessionId;

    return input && sessionId ? { ...input, sessionId } : null;
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
        .filter((event) => event.sessionId === hook.sessionId)
        .reduce((sum, event) => sum + costOf(event), 0);
    const todayCost = events
        .filter((event) => zonedDay(event.timestamp, options.timezone) === today)
        .reduce((sum, event) => sum + costOf(event), 0);
    const hookCost = hook.totalCostUsd;
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
    const totalInput = hook.contextWindow?.totalInputTokens;
    const windowSize = hook.contextWindow?.size;

    if (typeof totalInput === "number" && typeof windowSize === "number" && windowSize > 0) {
        const pct = Math.round((totalInput / windowSize) * 100);
        context = `${totalInput.toLocaleString()} (${pct}%)`;
    }

    const modelLabel = hook.model?.displayName ?? hook.model?.id ?? "unknown";
    const effort = hook.effortLevel ? ` (${hook.effortLevel})` : "";
    return `🤖 ${modelLabel}${effort} | 💰 ${sessionDisplay} session / ${usd(todayCost)} today / ${blockInfo}${burn} | 🧠 ${context}`;
}
