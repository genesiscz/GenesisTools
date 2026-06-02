import { costOf, priceFor } from "./pricing";
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

function eventsCost(events: UsageEvent[], pricing: PricingTable): number {
    let cost = 0;
    for (const ev of events) {
        const price = priceFor(ev.model, pricing);
        if (!price) {
            continue;
        }

        cost +=
            (ev.inputTokens * price.input +
                ev.outputTokens * price.output +
                ev.cacheCreationTokens * price.cacheWrite +
                ev.cacheReadTokens * price.cacheRead) /
            1_000_000;
    }

    return cost;
}

function dayCost(events: UsageEvent[], day: string, pricing: PricingTable): number {
    return eventsCost(
        events.filter((e) => dayOf(e.timestamp) === day),
        pricing
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
    const byModel = new Map<string, { tokens: TokenTotals; priced: boolean }>();
    const byDay = new Map<string, TokenTotals>();
    const byProject = new Map<string, { tokens: TokenTotals; sessions: Set<string> }>();
    const bySession = new Map<string, { tokens: TokenTotals; project: string; lastDay: string }>();

    for (const ev of kept) {
        addTokens(totalTokens, ev);

        const model = byModel.get(ev.model) ?? { tokens: emptyTotals(), priced: priceFor(ev.model, pricing) !== null };
        addTokens(model.tokens, ev);
        byModel.set(ev.model, model);

        const day = dayOf(ev.timestamp);
        const dayTok = byDay.get(day) ?? emptyTotals();
        addTokens(dayTok, ev);
        byDay.set(day, dayTok);

        const proj = byProject.get(ev.project) ?? { tokens: emptyTotals(), sessions: new Set<string>() };
        addTokens(proj.tokens, ev);
        proj.sessions.add(ev.sessionId);
        byProject.set(ev.project, proj);

        const sess = bySession.get(ev.sessionId) ?? { tokens: emptyTotals(), project: ev.project, lastDay: day };
        addTokens(sess.tokens, ev);
        if (day > sess.lastDay) {
            sess.lastDay = day;
        }

        bySession.set(ev.sessionId, sess);
    }

    const models: ModelBreakdown[] = [...byModel.entries()]
        .map(([model, v]) => {
            const price = priceFor(model, pricing);
            return {
                model,
                priced: v.priced,
                tokens: v.tokens,
                totalTokens: sumTokens(v.tokens),
                cost: price ? costOf(v.tokens, price) : 0,
            };
        })
        .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);

    const days: DayBreakdown[] = [...byDay.entries()]
        .map(([day, tokens]) => ({ day, totalTokens: sumTokens(tokens), cost: dayCost(kept, day, pricing) }))
        .sort((a, b) => a.day.localeCompare(b.day));

    const projects: ProjectBreakdown[] = [...byProject.entries()]
        .map(([project, v]) => ({
            project,
            sessions: v.sessions.size,
            totalTokens: sumTokens(v.tokens),
            cost: eventsCost(
                kept.filter((e) => e.project === project),
                pricing
            ),
        }))
        .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
        .slice(0, top);

    const sessions: SessionBreakdown[] = [...bySession.entries()]
        .map(([sessionId, v]) => ({
            sessionId,
            project: v.project,
            lastDay: v.lastDay,
            totalTokens: sumTokens(v.tokens),
            cost: eventsCost(
                kept.filter((e) => e.sessionId === sessionId),
                pricing
            ),
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
            cost: eventsCost(kept, pricing),
            cacheHitRate: cacheHitDenom === 0 ? 0 : totalTokens.cacheRead / cacheHitDenom,
        },
        days,
        models: models.slice(0, top),
        projects,
        sessions,
    };
}
