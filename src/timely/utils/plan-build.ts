import type { TimelyEntry } from "@app/timely/types/api";
import type { AvailableMemory, CreatePlanV1, PlanDay, PlanSuggestion } from "@app/timely/types/plan";
import { suggestProjects } from "@app/timely/utils/categorizer";
import type { CorpusEntry } from "@app/timely/utils/event-corpus";

function toAvailableMemories(buckets: TimelyEntry[]): AvailableMemory[] {
    const out: AvailableMemory[] = [];

    for (const bucket of buckets) {
        const inner = bucket.entries ?? [];
        if (inner.length === 0) {
            // Single-entry bucket without nested `entries[]`
            if (bucket.id && bucket.from && bucket.to) {
                const fromMs = new Date(bucket.from).getTime();
                const toMs = new Date(bucket.to).getTime();
                out.push({
                    id: bucket.id,
                    app: bucket.title ?? "",
                    note: bucket.note ?? "",
                    from: bucket.from,
                    to: bucket.to,
                    duration_min: Math.round(Math.max(0, (toMs - fromMs) / 60_000)),
                    sub_notes: [],
                });
            }

            continue;
        }

        for (const entry of inner) {
            const fromMs = new Date(entry.from).getTime();
            const toMs = new Date(entry.to).getTime();
            const subs = entry.sub_entries ?? [];
            const subNotes = Array.from(
                new Set(subs.map((s) => s.note).filter((n): n is string => Boolean(n) && n !== entry.note))
            );
            out.push({
                id: entry.id,
                app: entry.title ?? bucket.title ?? "",
                note: entry.note ?? "",
                from: entry.from,
                to: entry.to,
                duration_min: Math.round(Math.max(0, (toMs - fromMs) / 60_000)),
                sub_notes: subNotes,
            });
        }
    }

    return out.sort((a, b) => a.from.localeCompare(b.from));
}

function toSuggestions(buckets: TimelyEntry[], corpus: CorpusEntry[]): PlanSuggestion[] {
    return suggestProjects(buckets, corpus).map((s) => ({
        project_id: s.projectId,
        project_name: s.projectName,
        score: Number(s.score.toFixed(3)),
        reasons: s.reasons,
    }));
}

export function buildPlan(args: {
    memoriesByDate: Map<string, TimelyEntry[]>;
    corpus: CorpusEntry[];
    dates: string[];
    now?: Date;
}): CreatePlanV1 {
    const days: PlanDay[] = args.dates.map((day) => {
        const buckets = args.memoriesByDate.get(day) ?? [];
        return {
            day,
            available_memories: toAvailableMemories(buckets),
            suggestions: toSuggestions(buckets, args.corpus),
            events: [],
        };
    });

    return {
        version: 1,
        generated_at: (args.now ?? new Date()).toISOString(),
        days,
    };
}
