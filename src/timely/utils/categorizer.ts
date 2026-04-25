import type { TimelyEntry } from "@app/timely/types/api";
import type { CorpusEntry } from "@app/timely/utils/event-corpus";
import { timeOverlapRatio, wordSimilarity } from "@app/utils/fuzzy-match";

export interface CategorySuggestion {
    projectId: number;
    projectName: string;
    score: number;
    reasons: string[];
    sampleNotes: string[];
}

const CORPUS_WINDOW_DAYS = 56;

function recencyWeight(daysAgo: number): number {
    return Math.max(0, 1 - daysAgo / CORPUS_WINDOW_DAYS);
}

function memoryText(memory: TimelyEntry): string {
    const subNotes = (memory.sub_entries ?? []).map((s) => s.note).join(" ");
    return `${memory.title ?? ""} ${memory.note ?? ""} ${memory.description ?? ""} ${subNotes}`.trim();
}

function memoryRange(memory: TimelyEntry): { from: string; to: string } | null {
    if (!memory.from || !memory.to) {
        return null;
    }

    return { from: memory.from, to: memory.to };
}

interface Bucket {
    name: string;
    score: number;
    matches: number;
    notes: { note: string; sim: number }[];
}

export function suggestProjects(memories: TimelyEntry[], corpus: CorpusEntry[]): CategorySuggestion[] {
    if (memories.length === 0 || corpus.length === 0) {
        return [];
    }

    const text = memories.map(memoryText).join(" ");
    if (!text.trim()) {
        return [];
    }

    const ranges = memories.map(memoryRange).filter((r): r is { from: string; to: string } => r !== null);

    const buckets = new Map<number, Bucket>();

    for (const entry of corpus) {
        const target = `${entry.note} ${entry.projectName}`.trim();
        const wordSim = wordSimilarity(text, target);
        const timeSim =
            ranges.length > 0 && entry.from && entry.to
                ? Math.max(...ranges.map((r) => timeOverlapRatio(r, { from: entry.from, to: entry.to })))
                : 0;
        const r = recencyWeight(entry.daysAgo);
        const contribution = wordSim * 0.6 + timeSim * 0.2 + r * 0.2;
        if (contribution < 0.05) {
            continue;
        }

        const bucket = buckets.get(entry.projectId) ?? {
            name: entry.projectName,
            score: 0,
            matches: 0,
            notes: [],
        };
        bucket.score += contribution;
        bucket.matches += 1;
        if (entry.note) {
            bucket.notes.push({ note: entry.note, sim: wordSim });
        }

        buckets.set(entry.projectId, bucket);
    }

    return Array.from(buckets.entries())
        .map(([projectId, b]): CategorySuggestion => {
            const topSim = b.notes.length > 0 ? Math.max(...b.notes.map((n) => n.sim)) : 0;
            return {
                projectId,
                projectName: b.name,
                score: b.score,
                reasons: [`${b.matches} similar past entries`, `top word similarity ${topSim.toFixed(2)}`],
                sampleNotes: b.notes
                    .sort((a, b2) => b2.sim - a.sim)
                    .slice(0, 3)
                    .map((n) => n.note),
            };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
}
