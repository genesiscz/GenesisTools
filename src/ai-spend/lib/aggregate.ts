import { priceFor } from "./pricing";
import type {
    DayBreakdown,
    Filters,
    ModelBreakdown,
    PricingTable,
    ProjectBreakdown,
    Report,
    SessionBreakdown,
    TokenTotals,
    UsageEvent,
} from "./types";

interface AggregateArgs extends Filters {
    events: UsageEvent[];
    pricing: PricingTable;
    /** injected — the pure core never reads the system clock */
    now: Date;
}

function emptyTotals(): TokenTotals {
    return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

function addTokens(into: TokenTotals, ev: UsageEvent): void {
    into.input += ev.inputTokens;
    into.output += ev.outputTokens;
    into.cacheWrite += ev.cacheCreationTokens;
    into.cacheRead += ev.cacheReadTokens;
}

function sumTokens(t: TokenTotals): number {
    return t.input + t.output + t.cacheWrite + t.cacheRead;
}

function dayOf(timestamp: string): string {
    return timestamp.slice(0, 10);
}

function passesFilters(ev: UsageEvent, f: Filters): boolean {
    if (f.sinceDay && dayOf(ev.timestamp) < f.sinceDay) {
        return false;
    }

    if (f.model && !ev.model.toLowerCase().includes(f.model.toLowerCase())) {
        return false;
    }

    if (f.project && !ev.project.toLowerCase().includes(f.project.toLowerCase())) {
        return false;
    }

    return true;
}

function eventCost(ev: UsageEvent, pricing: PricingTable): number {
    const price = priceFor(ev.model, pricing);
    if (!price) {
        return 0;
    }

    return (
        (ev.inputTokens * price.input +
            ev.outputTokens * price.output +
            ev.cacheCreationTokens * price.cacheWrite +
            ev.cacheReadTokens * price.cacheRead) /
        1_000_000
    );
}

export function aggregate(args: AggregateArgs): Report {
    const { events, pricing, now } = args;
    const top = args.top ?? 10;

    const seen = new Set<string>();
    const kept: UsageEvent[] = [];
    for (const ev of events) {
        if (seen.has(ev.messageId)) {
            continue;
        }

        seen.add(ev.messageId);
        if (passesFilters(ev, args)) {
            kept.push(ev);
        }
    }

    const totalTokens = emptyTotals();
    let totalCost = 0;
    const byModel = new Map<string, { tokens: TokenTotals; cost: number; priced: boolean }>();
    const byDay = new Map<string, { tokens: TokenTotals; cost: number }>();
    const byProject = new Map<string, { tokens: TokenTotals; cost: number; sessions: Set<string> }>();
    const bySession = new Map<string, { tokens: TokenTotals; cost: number; project: string; lastDay: string }>();

    for (const ev of kept) {
        const evCost = eventCost(ev, pricing);
        totalCost += evCost;
        addTokens(totalTokens, ev);

        const model = byModel.get(ev.model) ?? {
            tokens: emptyTotals(),
            cost: 0,
            priced: priceFor(ev.model, pricing) !== null,
        };
        addTokens(model.tokens, ev);
        model.cost += evCost;
        byModel.set(ev.model, model);

        const day = dayOf(ev.timestamp);
        const dayAgg = byDay.get(day) ?? { tokens: emptyTotals(), cost: 0 };
        addTokens(dayAgg.tokens, ev);
        dayAgg.cost += evCost;
        byDay.set(day, dayAgg);

        const proj = byProject.get(ev.project) ?? { tokens: emptyTotals(), cost: 0, sessions: new Set<string>() };
        addTokens(proj.tokens, ev);
        proj.cost += evCost;
        proj.sessions.add(ev.sessionId);
        byProject.set(ev.project, proj);

        const sess = bySession.get(ev.sessionId) ?? {
            tokens: emptyTotals(),
            cost: 0,
            project: ev.project,
            lastDay: day,
        };
        addTokens(sess.tokens, ev);
        sess.cost += evCost;
        if (day > sess.lastDay) {
            sess.lastDay = day;
        }

        bySession.set(ev.sessionId, sess);
    }

    const models: ModelBreakdown[] = [...byModel.entries()]
        .map(([model, v]) => ({
            model,
            priced: v.priced,
            tokens: v.tokens,
            totalTokens: sumTokens(v.tokens),
            cost: v.cost,
        }))
        .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);

    const days: DayBreakdown[] = [...byDay.entries()]
        .map(([day, v]) => ({ day, totalTokens: sumTokens(v.tokens), cost: v.cost }))
        .sort((a, b) => a.day.localeCompare(b.day));

    const projects: ProjectBreakdown[] = [...byProject.entries()]
        .map(([project, v]) => ({
            project,
            sessions: v.sessions.size,
            totalTokens: sumTokens(v.tokens),
            cost: v.cost,
        }))
        .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
        .slice(0, top);

    const sessions: SessionBreakdown[] = [...bySession.entries()]
        .map(([sessionId, v]) => ({
            sessionId,
            project: v.project,
            lastDay: v.lastDay,
            totalTokens: sumTokens(v.tokens),
            cost: v.cost,
        }))
        .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
        .slice(0, top);

    const allDays = [...byDay.keys()].sort();
    const cacheHitDenom = totalTokens.input + totalTokens.cacheRead;

    return {
        windowStartDay: args.sinceDay ?? allDays[0] ?? dayOf(now.toISOString()),
        windowEndDay: allDays.at(-1) ?? dayOf(now.toISOString()),
        projectCount: byProject.size,
        sessionCount: bySession.size,
        total: {
            tokens: totalTokens,
            totalTokens: sumTokens(totalTokens),
            cost: totalCost,
            cacheHitRate: cacheHitDenom === 0 ? 0 : totalTokens.cacheRead / cacheHitDenom,
        },
        days,
        models: models.slice(0, top),
        projects,
        sessions,
    };
}
