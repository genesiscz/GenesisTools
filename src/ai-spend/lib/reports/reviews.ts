import type { CodexActivity, CodexTask } from "../drivers/codex-context";
import type { PricingTable } from "../types";
import { type CostEstimate, eventCostEstimate, totalTokensOf } from "./cost";
import { candidatesFor } from "./load";
import type { CostMode, SpendEvent } from "./types";

interface UsageSummary {
    costUSD: number | null;
    knownCostUSD: number;
    unpricedEvents: number;
    requests: number;
    longContextRequests: number;
    fastRequests: number;
    unspecifiedTierRequests: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
}

interface ReviewPass extends UsageSummary {
    sessionId: string;
    threadId?: string;
    parentThreadId?: string;
    accountId?: string;
    agentPath?: string;
    taskId: string;
    activity: CodexActivity;
    evidence: CodexTask["evidence"];
    startedAt: string;
    completedAt?: string;
    completed: boolean;
    models: string[];
}

export interface CodexAnalysis {
    totals: UsageSummary;
    models: Array<UsageSummary & { model: string }>;
    activities: Array<UsageSummary & { activity: CodexActivity }>;
    passes: ReviewPass[];
    notes: string[];
}

function empty(): UsageSummary {
    return {
        costUSD: 0,
        knownCostUSD: 0,
        unpricedEvents: 0,
        requests: 0,
        longContextRequests: 0,
        fastRequests: 0,
        unspecifiedTierRequests: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
    };
}

function add(row: UsageSummary, event: SpendEvent, estimate: CostEstimate): void {
    row.requests++;
    row.knownCostUSD += estimate.costUSD ?? 0;
    row.unpricedEvents += estimate.costUSD === null ? 1 : 0;
    row.costUSD = row.unpricedEvents > 0 ? null : row.knownCostUSD;
    row.longContextRequests += estimate.longContext ? 1 : 0;
    row.fastRequests += event.serviceTier === "fast" || event.serviceTier === "priority" ? 1 : 0;
    row.unspecifiedTierRequests += event.serviceTier === undefined ? 1 : 0;
    row.totalTokens += totalTokensOf(event);
    row.inputTokens += event.inputTokens;
    row.outputTokens += event.outputTokens;
    row.cacheReadTokens += event.cacheReadTokens;
    row.cacheCreationTokens += event.cacheCreationTokens;
}

/** Receives already-filtered events; price each request before summing any dimension. */
export function buildCodexAnalysis(events: SpendEvent[], pricing: PricingTable, mode: CostMode): CodexAnalysis {
    const totals = empty();
    const models = new Map<string, UsageSummary & { model: string }>();
    const activities = new Map<CodexActivity, UsageSummary & { activity: CodexActivity }>();
    const passes = new Map<string, ReviewPass>();

    for (const event of events) {
        if (event.source !== "codex") {
            continue;
        }

        const estimate = eventCostEstimate(event, pricing, mode, candidatesFor(event));
        const task = event.codex?.task;
        const activity = task?.kind ?? "unclassified";
        const model = models.get(event.model) ?? { ...empty(), model: event.model };
        const category = activities.get(activity) ?? { ...empty(), activity };
        for (const row of [totals, model, category]) {
            add(row, event, estimate);
        }
        models.set(event.model, model);
        activities.set(activity, category);

        if (
            !task ||
            (activity !== "code-review" &&
                activity !== "permission-review" &&
                !/review/i.test(event.codex?.agentPath ?? ""))
        ) {
            continue;
        }

        const key = `${event.accountId ?? event.home ?? ""}:${event.codex?.threadId ?? event.sessionId}:${task.id}`;
        const pass = passes.get(key) ?? {
            ...empty(),
            sessionId: event.sessionId,
            threadId: event.codex?.threadId,
            parentThreadId: event.codex?.parentThreadId,
            accountId: event.accountId,
            agentPath: event.codex?.agentPath,
            taskId: task.id,
            activity,
            evidence: task.evidence,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            completed: task.completed,
            models: [],
        };
        add(pass, event, estimate);
        if (!pass.models.includes(event.model)) {
            pass.models.push(event.model);
        }
        passes.set(key, pass);
    }

    const notes = [
        "Catalog costs are API-equivalent estimates, not subscription charges.",
        "Completion-text classification is heuristic; names alone never prove code review. Other work in reviewer sessions is shown separately.",
        "Pass costs include only requests inside the selected date/account window. Missing or encrypted completion text remains unclassified.",
        "Missing service tiers use standard rates; current config never rewrites historical usage.",
    ];
    if (totals.unpricedEvents > 0) {
        notes.push("Unpriced models have null costs. knownCostUSD is a partial subtotal, not a complete total.");
    }

    return {
        totals,
        models: [...models.values()].sort((a, b) => b.knownCostUSD - a.knownCostUSD),
        activities: [...activities.values()].sort((a, b) => a.activity.localeCompare(b.activity)),
        passes: [...passes.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
        notes,
    };
}
